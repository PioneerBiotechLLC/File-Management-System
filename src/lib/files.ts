import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";
import type { Db } from "@/lib/db";
import { DOC_TYPES } from "@/lib/doc-types";
import { limitsEnv } from "@/lib/env";
import { UserError } from "@/lib/errors";
import { cleanFileName, isBlockedFile, normalizeMimeType, previewKind } from "@/lib/file-names";
import { folderPaths, loadFolderAccess, restrictedFolderIds } from "@/lib/folders";
import { can } from "@/lib/permissions";
import { reindexFile } from "@/lib/search-index";
import { UPLOAD_URL_SECONDS, copy, head, objectKey, presignDownload, presignUpload, remove, uploadKey } from "@/lib/storage";

/**
 * A new upload waits unfiled in Review: the AI reads it, the uploader confirms the summary and
 * then the folder (see intake.ts). Every query here is limited to the folders the user may see.
 */

/** Matches the lifetime of an upload URL. */
export const UPLOAD_WINDOW_MS = UPLOAD_URL_SECONDS * 1000;
/** Uploads one person may have started and not finished within that window. */
const MAX_PENDING_UPLOADS = 20;
/** Matches intake.READ_TIMEOUT_MS: a read older than this no longer counts as "in progress". */
const READING_WINDOW_MS = 2 * 60 * 1000;
export const TRASH_DAYS = 30;
/** FileVersion.sizeBytes is a 32-bit integer. */
const MAX_BYTES_LIMIT = 2_000_000_000;
const PAGE_SIZE = 50;

export type FileContext = {
  orgId: string;
  userId: string;
  email: string;
  role: Role;
  /** Folders the user may see, and may file into. */
  visible: Set<string>;
  writable: Set<string>;
  /** Folders that are restricted or sit under a restricted folder. */
  restricted: Set<string>;
  paths: Map<string, string>;
  folders: Awaited<ReturnType<typeof loadFolderAccess>>["folders"];
};

export async function fileContext(
  prisma: Db,
  user: { orgId: string; userId: string; email: string; role: Role },
): Promise<FileContext> {
  const { folders, visible, writable } = await loadFolderAccess(prisma, user.orgId, user.userId, user.role);
  return { ...user, visible, writable, restricted: restrictedFolderIds(folders), paths: folderPaths(folders), folders };
}

/**
 * The files a user may see. Filed files follow folder access. Unfiled files (waiting in Review)
 * are visible only to their uploader and to admins.
 */
function visibleFiles(ctx: FileContext, extra: Prisma.StoredFileWhereInput = {}): Prisma.StoredFileWhereInput {
  return {
    orgId: ctx.orgId,
    status: { not: "uploading" },
    // Deleted files are hidden unless `extra` asks for them (Recently deleted).
    deletedAt: null,
    OR: [
      { folderId: { in: [...ctx.visible] } },
      { folderId: null, ...(ctx.role === "admin" ? {} : { uploadedBy: ctx.userId }) },
    ],
    ...extra,
  };
}

const notFound = () => new UserError("That file does not exist or you cannot open it.");

/**
 * A read-only grant on a restricted folder is read-only: files there may be changed, moved out,
 * deleted or re-versioned only by people who can write there. Admins can always.
 */
function assertCanChangeIn(ctx: FileContext, folderId: string | null): void {
  if (ctx.role === "admin" || folderId === null) return;
  if (ctx.restricted.has(folderId) && !ctx.writable.has(folderId)) throw new UserError("You have read-only access to that folder.");
}

const LIST_SELECT = {
  id: true,
  name: true,
  title: true,
  summary: true,
  mimeType: true,
  sizeBytes: true,
  docType: true,
  folderId: true,
  status: true,
  createdAt: true,
  uploadedBy: true,
  uploader: { select: { name: true, email: true } },
} satisfies Prisma.StoredFileSelect;

/** What Review needs: the draft summary and how the AI reading went. */
const REVIEW_SELECT = {
  ...LIST_SELECT,
  docDate: true,
  facts: true,
  tags: true,
  readStatus: true,
  aiModel: true,
  aiError: true,
  attempts: true,
  processingStartedAt: true,
  summaryConfirmedAt: true,
  suggestedFolderId: true,
  suggestedTrading: true,
  filingConfidence: true,
  filingReason: true,
} satisfies Prisma.StoredFileSelect;

export type ReviewItem = Prisma.StoredFileGetPayload<{ select: typeof REVIEW_SELECT }>;

type FileListItem = Prisma.StoredFileGetPayload<{ select: typeof LIST_SELECT }>;

const DETAIL_SELECT = {
  id: true,
  folderId: true,
  name: true,
  originalName: true,
  mimeType: true,
  sizeBytes: true,
  sha256: true,
  currentVersion: true,
  status: true,
  title: true,
  summary: true,
  docType: true,
  docDate: true,
  facts: true,
  tags: true,
  filedBy: true,
  readStatus: true,
  aiModel: true,
  aiError: true,
  summaryConfirmedAt: true,
  summaryConfirmedBy: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  uploadedBy: true,
  uploader: { select: { name: true, email: true } },
  versions: {
    select: { versionNo: true, sizeBytes: true, originalName: true, mimeType: true, createdAt: true, uploadedBy: true },
    orderBy: { versionNo: "desc" },
  },
} satisfies Prisma.StoredFileSelect;

type FileDetail = Omit<Prisma.StoredFileGetPayload<{ select: typeof DETAIL_SELECT }>, "versions"> & {
  /** Confirmed versions only, newest first. */
  versions: Prisma.StoredFileGetPayload<{ select: typeof DETAIL_SELECT }>["versions"];
  folderPath: string | null;
};

// ---------------------------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------------------------

const startInput = z.object({
  name: z.string().min(1).max(1_000),
  size: z.number().int().positive("The file is empty."),
  mimeType: z.string().max(300),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** A folder chosen up front files the upload at once, skipping the AI. The web app never does this. */
  folderId: z.string().min(1).nullish(),
  /** Set to add a new version to this file instead of creating a file. */
  fileId: z.string().min(1).nullish(),
  allowDuplicate: z.boolean().optional(),
});

export type StartUploadInput = z.input<typeof startInput>;

type StartUploadResult =
  | { kind: "upload"; fileId: string; versionNo: number; uploadUrl: string; contentType: string; name: string }
  | { kind: "duplicate"; existing: { id: string; name: string; folderPath: string | null } };

function maxBytes(): number {
  return Math.min(limitsEnv().FILES_MAX_MB * 1024 * 1024, MAX_BYTES_LIMIT);
}

async function discardPendingVersions(prisma: Db, ctx: FileContext, file: { id: string; currentVersion: number }) {
  const pending = await prisma.fileVersion.findMany({
    where: { fileId: file.id, versionNo: { gt: file.currentVersion } },
    select: { id: true, versionNo: true, uploadedBy: true, createdAt: true },
  });
  for (const row of pending) {
    const abandoned = Date.now() - row.createdAt.getTime() > UPLOAD_WINDOW_MS;
    if (!abandoned && row.uploadedBy !== ctx.userId) throw new UserError("Someone else is uploading a new version of this file right now.");
  }
  for (const row of pending) {
    await remove(uploadKey(ctx.orgId, file.id, row.versionNo)).catch(() => undefined);
    await prisma.fileVersion.delete({ where: { id: row.id } });
  }
}

/**
 * Step 1 of an upload: checks the rules, records the pending file or version, and returns a
 * presigned URL for the browser to PUT the bytes to. An identical file already in the company is
 * reported instead, so the user can open it or upload anyway.
 */
export async function startUpload(prisma: Db, ctx: FileContext, rawInput: StartUploadInput): Promise<StartUploadResult> {
  const input = startInput.parse(rawInput);
  const name = cleanFileName(input.name);
  const mimeType = normalizeMimeType(input.mimeType);
  if (!can(ctx.role, "file.upload")) throw new UserError("You do not have permission to upload files.");
  if (isBlockedFile(name, mimeType)) throw new UserError(`${name} is an executable or script, so it cannot be stored.`);
  if (input.size > maxBytes()) {
    throw new UserError(`${name} is larger than the ${Math.floor(maxBytes() / (1024 * 1024))} MB limit.`);
  }

  if (input.fileId) {
    const file = await findFile(prisma, ctx, input.fileId);
    if (!can(ctx.role, "file.rename", { ownsFile: file.uploadedBy === ctx.userId })) {
      throw new UserError("You can only add versions to files you uploaded.");
    }
    assertCanChangeIn(ctx, file.folderId);
    if (file.sha256 === input.sha256) throw new UserError("This is identical to the current version.");
    await discardPendingVersions(prisma, ctx, file);
    const versionNo = file.currentVersion + 1;
    await prisma.fileVersion.create({
      data: { fileId: file.id, versionNo, sizeBytes: input.size, sha256: input.sha256, originalName: name, mimeType, uploadedBy: ctx.userId },
    });
    const uploadUrl = await presignUpload(uploadKey(ctx.orgId, file.id, versionNo), mimeType);
    return { kind: "upload", fileId: file.id, versionNo, uploadUrl, contentType: mimeType, name: file.name };
  }

  if (input.folderId && !ctx.writable.has(input.folderId)) throw new UserError("You cannot upload to that folder.");

  // Only admins upload in bulk: everyone else waits for the AI to finish reading the last file.
  if (ctx.role !== "admin") {
    const reading = await prisma.storedFile.count({
      where: { orgId: ctx.orgId, uploadedBy: ctx.userId, status: "processing", processingStartedAt: { gte: new Date(Date.now() - READING_WINDOW_MS) } },
    });
    if (reading > 0) throw new UserError("Wait for the file being read to finish, then upload the next one.");
  }
  // Nobody starts uploads without finishing them: each one holds a row and may hold bucket space.
  const pending = await prisma.storedFile.count({
    where: { orgId: ctx.orgId, uploadedBy: ctx.userId, status: "uploading", createdAt: { gte: new Date(Date.now() - UPLOAD_WINDOW_MS) } },
  });
  if (pending >= MAX_PENDING_UPLOADS) throw new UserError("Too many uploads are still in progress. Let them finish, then try again.");

  if (!input.allowDuplicate) {
    const existing = await prisma.storedFile.findFirst({
      where: visibleFiles(ctx, { sha256: input.sha256 }),
      select: { id: true, name: true, folderId: true },
      orderBy: { createdAt: "asc" },
    });
    if (existing) {
      return { kind: "duplicate", existing: { id: existing.id, name: existing.name, folderPath: existing.folderId ? (ctx.paths.get(existing.folderId) ?? null) : null } };
    }
  }

  const file = await prisma.storedFile.create({
    data: {
      orgId: ctx.orgId,
      folderId: input.folderId ?? null,
      name,
      originalName: name,
      mimeType,
      sizeBytes: input.size,
      sha256: input.sha256,
      status: "uploading",
      uploadedBy: ctx.userId,
      versions: { create: { versionNo: 1, sizeBytes: input.size, sha256: input.sha256, originalName: name, mimeType, uploadedBy: ctx.userId } },
    },
    select: { id: true },
  });
  const uploadUrl = await presignUpload(uploadKey(ctx.orgId, file.id, 1), mimeType);
  return { kind: "upload", fileId: file.id, versionNo: 1, uploadUrl, contentType: mimeType, name };
}

type ConfirmResult = {
  fileId: string;
  name: string;
  versionNo: number;
  /** "ready" when filed; "processing" when the AI is to read it next; "needs_review" when it waits in Review. */
  status: "ready" | "processing" | "needs_review";
  folderPath: string | null;
};

/**
 * Step 2: checks the bytes arrived with the size the browser declared, copies them from the
 * staging key to the version's own key, then makes the file or version real. A new file goes to
 * "processing" for the AI to read (intake.readUpload), unless a folder was chosen up front, which
 * files it at once. Confirming twice is harmless.
 */
export async function confirmUpload(
  prisma: Db,
  ctx: FileContext,
  input: { fileId: string; versionNo: number },
): Promise<ConfirmResult> {
  const file = await prisma.storedFile.findFirst({
    where: { id: input.fileId, orgId: ctx.orgId, deletedAt: null },
    select: { id: true, name: true, originalName: true, folderId: true, status: true, currentVersion: true, uploadedBy: true },
  });
  const version = await prisma.fileVersion.findUnique({
    where: { fileId_versionNo: { fileId: input.fileId, versionNo: input.versionNo } },
  });
  if (!file || !version || version.uploadedBy !== ctx.userId) throw new UserError("That upload was not found. Please try again.");

  const isNewFile = file.status === "uploading" && input.versionNo === 1;
  const done = (status: ConfirmResult["status"], folderId: string | null): ConfirmResult => ({
    fileId: file.id,
    name: file.name,
    versionNo: input.versionNo,
    status,
    folderPath: folderId ? (ctx.paths.get(folderId) ?? null) : null,
  });

  // Already confirmed.
  if (!isNewFile && input.versionNo <= file.currentVersion) return done(file.folderId ? "ready" : file.status === "processing" ? "processing" : "needs_review", file.folderId);
  if (!isNewFile && input.versionNo !== file.currentVersion + 1) throw new UserError("A newer version was uploaded first. Please try again.");
  if (!isNewFile && !can(ctx.role, "file.rename", { ownsFile: file.uploadedBy === ctx.userId })) {
    throw new UserError("You can only add versions to files you uploaded.");
  }
  if (!isNewFile) assertCanChangeIn(ctx, file.folderId);

  const staging = uploadKey(ctx.orgId, file.id, input.versionNo);
  const stored = await head(staging);
  if (!stored) throw new UserError("The file did not finish uploading. Please try again.");
  if (stored.sizeBytes !== version.sizeBytes) {
    await remove(staging).catch(() => undefined);
    if (isNewFile) await prisma.storedFile.delete({ where: { id: file.id } });
    else await prisma.fileVersion.delete({ where: { id: version.id } });
    throw new UserError("The uploaded file was not the size expected, so it was discarded. Please try again.");
  }
  // From here on only the copy is ever read; the upload URL can no longer change what was checked.
  await copy(staging, objectKey(ctx.orgId, file.id, input.versionNo), version.mimeType ?? "application/octet-stream");
  await remove(staging).catch(() => undefined);

  if (isNewFile) {
    const folderId = file.folderId && ctx.writable.has(file.folderId) ? file.folderId : null;
    const status = folderId ? "ready" : "processing";
    await prisma.$transaction([
      prisma.storedFile.update({ where: { id: file.id }, data: { status, folderId, filedBy: folderId ? ctx.email : null } }),
      prisma.auditLog.create({
        data: {
          orgId: ctx.orgId,
          userEmail: ctx.email,
          action: "file.upload",
          targetType: "file",
          targetId: file.id,
          after: { name: file.name, folderId, sizeBytes: version.sizeBytes, sha256: version.sha256 },
        },
      }),
    ]);
    return done(status, folderId);
  }

  const advanced = await prisma.storedFile.updateMany({
    where: { id: file.id, currentVersion: input.versionNo - 1 },
    data: {
      currentVersion: input.versionNo,
      sizeBytes: version.sizeBytes,
      sha256: version.sha256,
      mimeType: version.mimeType ?? undefined,
      originalName: version.originalName ?? file.originalName,
    },
  });
  if (advanced.count === 0) throw new UserError("A newer version was uploaded first. Please try again.");
  await prisma.auditLog.create({
    data: {
      orgId: ctx.orgId,
      userEmail: ctx.email,
      action: "file.version",
      targetType: "file",
      targetId: file.id,
      after: { versionNo: input.versionNo, sizeBytes: version.sizeBytes, sha256: version.sha256 },
    },
  });
  return done(file.folderId ? "ready" : "needs_review", file.folderId);
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

async function findFile(prisma: Db, ctx: FileContext, fileId: string) {
  const file = await prisma.storedFile.findFirst({
    where: visibleFiles(ctx, { id: fileId }),
    select: { id: true, name: true, mimeType: true, folderId: true, currentVersion: true, uploadedBy: true, sha256: true, summaryConfirmedAt: true },
  });
  if (!file) throw notFound();
  return file;
}

export type ListFilesOptions = {
  /** One folder (its own files, not its subfolders); omitted for every file the user can see. */
  folderId?: string;
  sort?: "name" | "createdAt" | "sizeBytes";
  dir?: "asc" | "desc";
  page?: number;
};

export async function listFiles(prisma: Db, ctx: FileContext, options: ListFilesOptions = {}) {
  const sort = options.sort ?? "createdAt";
  const dir = options.dir ?? (sort === "name" ? "asc" : "desc");
  const page = Number.isSafeInteger(options.page) && options.page! > 0 ? options.page! : 1;
  if (options.folderId !== undefined && !ctx.visible.has(options.folderId)) return { items: [], total: 0, page, pages: 1 };

  const where = visibleFiles(ctx, options.folderId !== undefined ? { folderId: options.folderId } : {});
  const [items, total] = await Promise.all([
    prisma.storedFile.findMany({
      where,
      select: LIST_SELECT,
      orderBy: [{ [sort]: dir }, { id: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.storedFile.count({ where }),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}

/** Files waiting in Review (being read, or needing a summary or a folder): the uploader's own, or everyone's for admins. */
export async function listUnfiled(prisma: Db, ctx: FileContext): Promise<ReviewItem[]> {
  return prisma.storedFile.findMany({
    where: unfiledWhere(ctx),
    select: REVIEW_SELECT,
    orderBy: { createdAt: "asc" },
    take: 200,
  });
}

type UnfiledScope = Pick<FileContext, "orgId" | "userId" | "role">;

function unfiledWhere(ctx: UnfiledScope): Prisma.StoredFileWhereInput {
  return {
    orgId: ctx.orgId,
    status: { in: ["processing", "needs_review"] },
    folderId: null,
    deletedAt: null,
    ...(ctx.role === "admin" ? {} : { uploadedBy: ctx.userId }),
  };
}

export async function countUnfiled(prisma: Db, ctx: UnfiledScope): Promise<number> {
  return prisma.storedFile.count({ where: unfiledWhere(ctx) });
}

/** Deleted files the user may restore, until they are purged after 30 days. */
export async function listDeleted(prisma: Db, ctx: FileContext): Promise<(FileListItem & { deletedAt: Date | null })[]> {
  const since = new Date(Date.now() - TRASH_DAYS * 24 * 60 * 60 * 1000);
  const rows = await prisma.storedFile.findMany({
    where: visibleFiles(ctx, { deletedAt: { gte: since } }),
    select: { ...LIST_SELECT, deletedAt: true },
    orderBy: { deletedAt: "desc" },
    take: 200,
  });
  return rows.filter((f) => can(ctx.role, "file.restore", { ownsFile: f.uploadedBy === ctx.userId }));
}

export async function getFile(prisma: Db, ctx: FileContext, fileId: string): Promise<FileDetail | null> {
  const row = await prisma.storedFile.findFirst({ where: visibleFiles(ctx, { id: fileId }), select: DETAIL_SELECT });
  if (!row) return null;
  return {
    ...row,
    versions: row.versions.filter((v) => v.versionNo <= row.currentVersion),
    folderPath: row.folderId ? (ctx.paths.get(row.folderId) ?? null) : null,
  };
}

/**
 * A short-lived URL for one version of a file. Every download and preview is audited.
 * `inline` is for the in-browser preview and only works for PDFs and common images.
 */
export async function downloadTarget(
  prisma: Db,
  ctx: FileContext,
  input: { fileId: string; versionNo?: number; inline?: boolean },
): Promise<{ url: string; name: string }> {
  const file = await prisma.storedFile.findFirst({
    where: visibleFiles(ctx, { id: input.fileId }),
    select: { id: true, name: true, mimeType: true, folderId: true, currentVersion: true },
  });
  if (!file) throw notFound();
  const versionNo = input.versionNo ?? file.currentVersion;
  if (versionNo < 1 || versionNo > file.currentVersion) throw notFound();

  let name = file.name;
  let mimeType = file.mimeType;
  if (versionNo !== file.currentVersion) {
    const version = await prisma.fileVersion.findUnique({ where: { fileId_versionNo: { fileId: file.id, versionNo } } });
    if (!version) throw notFound();
    name = version.originalName ?? file.name;
    mimeType = version.mimeType ?? file.mimeType;
  }
  if (input.inline && !previewKind(mimeType)) throw new UserError("This type of file cannot be previewed.");

  await prisma.auditLog.create({
    data: {
      orgId: ctx.orgId,
      userEmail: ctx.email,
      action: input.inline ? "file.preview" : "file.download",
      targetType: "file",
      targetId: file.id,
      after: { name, versionNo, current: versionNo === file.currentVersion, folderId: file.folderId },
    },
  });
  const url = await presignDownload(objectKey(ctx.orgId, file.id, versionNo), name, {
    inline: input.inline,
    contentType: input.inline ? mimeType : undefined,
  });
  return { url, name };
}

// ---------------------------------------------------------------------------------------------
// Changing
// ---------------------------------------------------------------------------------------------

/** Whether this person may file or move this file at all, wherever it goes. Returns the file. */
export async function checkCanMove(prisma: Db, ctx: FileContext, fileId: string) {
  const file = await findFile(prisma, ctx, fileId);
  const ownsFile = file.uploadedBy === ctx.userId;
  const allowed = file.folderId === null ? can(ctx.role, "review.accept") && (ownsFile || ctx.role === "admin") : can(ctx.role, "file.move", { ownsFile });
  if (!allowed) throw new UserError("You can only move files you uploaded.");
  assertCanChangeIn(ctx, file.folderId);
  if (file.folderId === null && !file.summaryConfirmedAt) throw new UserError("Confirm the summary before filing.");
  return file;
}

/**
 * Files an unfiled file into a folder, or moves a filed one. Unfiled files go through the Review
 * permission and need a confirmed summary first, so every filed file has one. Filing into a
 * customer or supplier folder records that company on the file (see parties.fileTo).
 */
export async function moveFile(prisma: Db, ctx: FileContext, input: { fileId: string; folderId: string }): Promise<void> {
  const file = await checkCanMove(prisma, ctx, input.fileId);
  if (!ctx.writable.has(input.folderId)) throw new UserError("You cannot file into that folder.");
  if (file.folderId === input.folderId) return;
  const partyId = ctx.folders.find((f) => f.id === input.folderId)?.partyId ?? null;

  await prisma.$transaction([
    prisma.storedFile.update({
      where: { id: file.id },
      data: { folderId: input.folderId, partyId, status: "ready", filedBy: ctx.email, processingStartedAt: null },
    }),
    prisma.auditLog.create({
      data: {
        orgId: ctx.orgId,
        userEmail: ctx.email,
        action: "file.move",
        targetType: "file",
        targetId: file.id,
        before: { folderId: file.folderId },
        after: { folderId: input.folderId },
      },
    }),
  ]);
}

export async function renameFile(prisma: Db, ctx: FileContext, input: { fileId: string; name: string }): Promise<void> {
  const file = await findFile(prisma, ctx, input.fileId);
  if (!can(ctx.role, "file.rename", { ownsFile: file.uploadedBy === ctx.userId })) throw new UserError("You can only rename files you uploaded.");
  assertCanChangeIn(ctx, file.folderId);
  const name = cleanFileName(z.string().min(1).max(1_000).parse(input.name));
  if (isBlockedFile(name, file.mimeType)) throw new UserError("A file cannot be renamed to an executable or script.");
  if (name === file.name) return;
  await prisma.$transaction([
    prisma.storedFile.update({ where: { id: file.id }, data: { name } }),
    prisma.auditLog.create({
      data: { orgId: ctx.orgId, userEmail: ctx.email, action: "file.rename", targetType: "file", targetId: file.id, before: { name: file.name }, after: { name } },
    }),
  ]);
  await reindexFile(prisma, file.id);
}

const tagText = z.string().transform((raw) => {
  const tags: string[] = [];
  for (const part of raw.split(/[,،\n]/)) {
    const tag = part.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 40);
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  return tags.slice(0, 20);
});

const detailsInput = z.object({
  title: z.string().trim().max(200).transform((v) => v || null),
  summary: z.string().trim().max(2_000).transform((v) => v || null),
  docType: z.union([z.enum(DOC_TYPES), z.literal("")]).transform((v) => v || null),
  docDate: z
    .string()
    .trim()
    .transform((v, c) => {
      if (v === "") return null;
      const date = new Date(`${v}T00:00:00.000Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== v) {
        c.addIssue({ code: "custom", message: "Enter the date as YYYY-MM-DD." });
        return z.NEVER;
      }
      return date;
    }),
  tags: tagText,
});

/** Title, summary, type, date and tags: what makes a file findable later. */
export async function updateFileDetails(
  prisma: Db,
  ctx: FileContext,
  input: { fileId: string } & Record<"title" | "summary" | "docType" | "docDate" | "tags", string>,
): Promise<void> {
  const file = await findFile(prisma, ctx, input.fileId);
  if (!can(ctx.role, "file.rename", { ownsFile: file.uploadedBy === ctx.userId })) throw new UserError("You can only edit files you uploaded.");
  assertCanChangeIn(ctx, file.folderId);
  const parsed = detailsInput.safeParse(input);
  if (!parsed.success) throw new UserError(parsed.error.issues[0]?.message ?? "Check the details and try again.");
  const before = await prisma.storedFile.findUniqueOrThrow({
    where: { id: file.id },
    select: { title: true, summary: true, docType: true, docDate: true, tags: true },
  });
  await prisma.$transaction([
    prisma.storedFile.update({ where: { id: file.id }, data: parsed.data }),
    prisma.auditLog.create({
      data: {
        orgId: ctx.orgId,
        userEmail: ctx.email,
        action: "file.details",
        targetType: "file",
        targetId: file.id,
        before: { ...before, docDate: before.docDate?.toISOString().slice(0, 10) ?? null },
        after: { ...parsed.data, docDate: parsed.data.docDate?.toISOString().slice(0, 10) ?? null },
      },
    }),
  ]);
  await reindexFile(prisma, file.id);
}

/** Soft delete: the file disappears from lists and can be restored for 30 days. */
export async function deleteFile(prisma: Db, ctx: FileContext, input: { fileId: string }): Promise<void> {
  const file = await findFile(prisma, ctx, input.fileId);
  if (!can(ctx.role, "file.delete", { ownsFile: file.uploadedBy === ctx.userId })) throw new UserError("You can only delete files you uploaded.");
  assertCanChangeIn(ctx, file.folderId);
  await prisma.$transaction([
    prisma.storedFile.update({ where: { id: file.id }, data: { deletedAt: new Date() } }),
    prisma.auditLog.create({
      data: { orgId: ctx.orgId, userEmail: ctx.email, action: "file.delete", targetType: "file", targetId: file.id, before: { name: file.name, folderId: file.folderId } },
    }),
  ]);
}

export async function restoreFile(prisma: Db, ctx: FileContext, input: { fileId: string }): Promise<void> {
  const since = new Date(Date.now() - TRASH_DAYS * 24 * 60 * 60 * 1000);
  const file = await prisma.storedFile.findFirst({
    where: visibleFiles(ctx, { id: input.fileId, deletedAt: { gte: since } }),
    select: { id: true, name: true, folderId: true, uploadedBy: true },
  });
  if (!file) throw new UserError("That file cannot be restored. It may have been purged after 30 days.");
  if (!can(ctx.role, "file.restore", { ownsFile: file.uploadedBy === ctx.userId })) throw new UserError("You can only restore files you uploaded.");
  // Restoring puts the file back where it was, so that folder must still accept files from this person.
  if (ctx.role !== "admin" && file.folderId && !ctx.writable.has(file.folderId)) {
    throw new UserError("That file's folder no longer accepts your files, so an admin has to restore it.");
  }
  await prisma.$transaction([
    prisma.storedFile.update({ where: { id: file.id }, data: { deletedAt: null } }),
    prisma.auditLog.create({
      data: { orgId: ctx.orgId, userEmail: ctx.email, action: "file.restore", targetType: "file", targetId: file.id, after: { name: file.name, folderId: file.folderId } },
    }),
  ]);
}
