import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { limitsEnv } from "@/lib/env";
import { UserError } from "@/lib/errors";
import { deleteFile, fileContext, type FileContext } from "@/lib/files";
import type { Destination, FilingSuggestion } from "@/lib/file-kinds";
import { generalFolderId } from "@/lib/folders";
import { MAX_READ_ATTEMPTS, NOT_SET_UP, NOT_THE_UPLOAD, readUpload, retryRead } from "@/lib/intake";
import { fileTo, yearChoice, listMaterials, listParties, suggestionFor } from "@/lib/parties";
import { reindexFile } from "@/lib/search-index";

/**
 * Bulk upload: an admin's files are filed straight after the AI reads them, with no one
 * confirming. A file the AI is at least AUTO_FILE_THRESHOLD sure about goes where it chose; one it
 * is less sure about, or that has no place in the tree, goes to General, marked unsure. A file the
 * AI cannot read at all (damaged, empty, a kind it cannot open) is deleted, and can be restored
 * from Deleted for 30 days. A file too large for the AI goes to General under its own name,
 * marked unsure. Only a read that failed for a reason that may pass waits in Review.
 */

export const AUTO_FILE_THRESHOLD = 0.6;

export type BulkOutcome =
  | { action: "filed"; path: string; confidence: number; newParty: string | null; unsure: boolean }
  | { action: "deleted"; reason: string }
  | { action: "review"; reason: string };

/**
 * Where the AI's answer files a file with no one confirming, or why it waits. Sure enough, it goes
 * where the AI chose. Otherwise it goes to General when `general` allows (a file nobody has filed
 * yet), and waits when not (moving a file that is already filed).
 */
export function autoFileTarget(
  suggestion: FilingSuggestion | null,
  storedConfidence: number | null,
  ctx: Pick<FileContext, "folders" | "writable" | "paths">,
  opts: { threshold: number; general: boolean },
): FilingSuggestion | { wait: string } {
  const confidence = suggestion?.confidence ?? storedConfidence ?? 0;
  const percent = Math.round(confidence * 100);
  const sure = confidence >= opts.threshold;
  if (sure && suggestion) return suggestion;
  const doubt = !sure
    ? suggestion
      ? `The AI was only ${percent}% sure it belongs in ${suggestion.path}.`
      : `The AI could not tell where it belongs (${percent}% sure).`
    : "The AI found no place for it.";
  if (!opts.general) return { wait: doubt };
  const general = generalFolderId(ctx.folders, ctx.writable);
  if (!general) return { wait: `${doubt} There is no General folder to put it in.` };
  const destination = { kind: "folder", folderId: general } as const;
  return { destination, path: ctx.paths.get(general) ?? "General", newParty: false, newMaterial: false, seenAs: null, confidence, reason: sure ? "No place in the tree" : doubt };
}

/** Files a file where the AI chose, marking it unsure when that is General. Returns whether it was. */
export async function fileByAi(prisma: Db, ctx: FileContext, input: { fileId: string; destination: Destination; seenAs?: string | null }): Promise<boolean> {
  const { folderId } = await fileTo(prisma, ctx, input);
  const unsure = folderId === generalFolderId(ctx.folders, ctx.writable);
  if (unsure) await prisma.storedFile.update({ where: { id: input.fileId }, data: { unsure: true } });
  return unsure;
}

/**
 * A file the AI could not read because of what it is: not one too large for it, or one that was
 * not read for a reason on this side.
 */
export function cannotBeRead(file: { readStatus: string | null; aiError: string | null; sizeBytes: number }): boolean {
  if (file.readStatus !== "not_read" || tooLargeForAi(file)) return false;
  return file.aiError !== NOT_SET_UP && file.aiError !== NOT_THE_UPLOAD;
}

/** Reasons a file was not read that mean "too big", whatever the check that said so (the AI's limit, a parser's, or sending kept dying). */
export const TOO_BIG_REASON = /larger than|too heavy/i;

/** Not read because the file is too large or too heavy for the AI, not because of what it is. */
export function tooLargeForAi(file: { readStatus: string | null; sizeBytes: number; aiError?: string | null }): boolean {
  return file.readStatus === "not_read" && (file.sizeBytes > limitsEnv().FILES_AI_MAX_MB * 1024 * 1024 || TOO_BIG_REASON.test(file.aiError ?? ""));
}

/** A file too large for the AI goes to General under its own name, marked unsure, for someone to move. */
async function fileByName(prisma: Db, ctx: FileContext, file: { id: string; name: string }, reason: string): Promise<BulkOutcome> {
  const general = generalFolderId(ctx.folders, ctx.writable);
  if (!general) return { action: "review", reason: `${reason} There is no General folder to put it in.` };
  await prisma.$transaction([
    prisma.storedFile.update({
      where: { id: file.id },
      data: { title: file.name, summary: `${reason} Filed in General under its name; move it where it belongs.`, summaryConfirmedAt: new Date(), summaryConfirmedBy: ctx.email, processingStartedAt: null },
    }),
    prisma.auditLog.create({
      data: { orgId: ctx.orgId, userEmail: ctx.email, action: "file.summary", targetType: "file", targetId: file.id, after: { name: file.name, source: "name", edited: false, auto: true } },
    }),
  ]);
  await reindexFile(prisma, file.id);
  const unsure = await fileByAi(prisma, ctx, { fileId: file.id, destination: { kind: "folder", folderId: general } });
  return { action: "filed", path: ctx.paths.get(general) ?? "General", confidence: 0, newParty: null, unsure };
}

export async function autoFileAfterRead(
  prisma: Db,
  ctx: FileContext,
  company: { timezone: string },
  fileId: string,
): Promise<BulkOutcome> {
  if (ctx.role !== "admin") throw new UserError("Only admins can file without confirming.");
  const file = await prisma.storedFile.findFirst({
    where: { id: fileId, orgId: ctx.orgId, folderId: null, deletedAt: null },
    select: {
      id: true,
      name: true,
      status: true,
      readStatus: true,
      aiError: true,
      sizeBytes: true,
      docDate: true,
      createdAt: true,
      summaryConfirmedAt: true,
      suggestedFolderId: true,
      suggestedTrading: true,
      filingConfidence: true,
      filingReason: true,
    },
  });
  if (!file) throw new UserError("That file was not found, or is already filed.");
  if (file.status !== "needs_review" || file.summaryConfirmedAt) throw new UserError("That file is not waiting to be filed.");
  if (file.readStatus !== "full" && file.readStatus !== "partial") {
    const reason = file.aiError ? `The AI could not read it: ${file.aiError}` : "The AI did not read it.";
    if (tooLargeForAi(file)) return fileByName(prisma, ctx, file, reason);
    if (!cannotBeRead(file)) return { action: "review", reason };
    await deleteFile(prisma, ctx, { fileId: file.id });
    return { action: "deleted", reason };
  }

  const [parties, materials] = await Promise.all([listParties(prisma, ctx.orgId), listMaterials(prisma, ctx.orgId)]);
  const year = yearChoice(file.docDate, file.createdAt, company.timezone);
  const suggestion = suggestionFor(
    { folderId: file.suggestedFolderId, trading: file.suggestedTrading, confidence: file.filingConfidence, reason: file.filingReason },
    ctx,
    parties,
    year,
    materials,
  );
  const target = autoFileTarget(suggestion, file.filingConfidence, ctx, { threshold: AUTO_FILE_THRESHOLD, general: true });
  if ("wait" in target) return { action: "review", reason: target.wait };

  // The summary stands as the AI wrote it; the log says so.
  await prisma.$transaction([
    prisma.storedFile.update({ where: { id: file.id }, data: { summaryConfirmedAt: new Date(), summaryConfirmedBy: ctx.email, processingStartedAt: null } }),
    prisma.auditLog.create({
      data: { orgId: ctx.orgId, userEmail: ctx.email, action: "file.summary", targetType: "file", targetId: file.id, after: { name: file.name, source: "ai", edited: false, auto: true } },
    }),
  ]);
  await reindexFile(prisma, file.id);
  const unsure = await fileByAi(prisma, ctx, { fileId: file.id, destination: target.destination, seenAs: target.seenAs });
  return {
    action: "filed",
    path: target.path,
    confidence: target.confidence,
    newParty: target.newParty && target.destination.kind !== "folder" ? target.destination.partyName : null,
    unsure,
  };
}

/**
 * Review files that clearing Review settles: the ones the AI read, which are filed; the ones too
 * large for it, which go to General by name; the ones it cannot read, which are deleted; and the
 * reads that failed, which are tried once more. A file a person has started confirming stays, as
 * do files still being read.
 */
function settleWhere(orgId: string) {
  const max = limitsEnv().FILES_AI_MAX_MB * 1024 * 1024;
  const read: Prisma.StoredFileWhereInput = { readStatus: { in: ["full", "partial"] } };
  const tooLarge: Prisma.StoredFileWhereInput = { readStatus: "not_read", OR: [{ sizeBytes: { gt: max } }, { aiError: { contains: "larger than", mode: "insensitive" } }, { aiError: { contains: "too heavy", mode: "insensitive" } }] };
  const unreadable: Prisma.StoredFileWhereInput = {
    readStatus: "not_read",
    sizeBytes: { lte: max },
    aiError: { notIn: [NOT_SET_UP, NOT_THE_UPLOAD] },
    NOT: [{ aiError: { contains: "larger than", mode: "insensitive" } }, { aiError: { contains: "too heavy", mode: "insensitive" } }],
  };
  const failedRead: Prisma.StoredFileWhereInput = { readStatus: null, aiError: { not: null }, attempts: { lt: MAX_READ_ATTEMPTS } };
  const waiting: Prisma.StoredFileWhereInput = { orgId, folderId: null, deletedAt: null, status: "needs_review", summaryConfirmedAt: null };
  return {
    toFile: { ...waiting, OR: [read, tooLarge] },
    toDelete: { ...waiting, ...unreadable },
    toRetry: { ...waiting, ...failedRead },
    either: { ...waiting, OR: [read, tooLarge, unreadable, failedRead] },
  };
}

export async function reviewToSettle(prisma: Db, orgId: string): Promise<{ toFile: number; toDelete: number; toRetry: number }> {
  const where = settleWhere(orgId);
  const [toFile, toDelete, toRetry] = await Promise.all([
    prisma.storedFile.count({ where: where.toFile }),
    prisma.storedFile.count({ where: where.toDelete }),
    prisma.storedFile.count({ where: where.toRetry }),
  ]);
  return { toFile, toDelete, toRetry };
}

export type SettleResult = { filed: number; unsure: number; deleted: number; kept: number; next: string | null };

/**
 * Clears Review the way bulk upload files, a few files per call: `next` is where the following
 * call starts ("" when nothing was done yet), null when there is nothing after this one. A failed
 * read is tried once more first, which takes the AI a while, so a call also stops at the deadline.
 */
export async function settleReview(
  prisma: Db,
  ctx: FileContext,
  company: { name: string; domain: string; timezone: string },
  opts: { after?: string | null; limit: number; deadlineAt?: Date },
): Promise<SettleResult> {
  if (ctx.role !== "admin") throw new UserError("Only admins can clear Review.");
  const rows = await prisma.storedFile.findMany({
    where: { ...settleWhere(ctx.orgId).either, ...(opts.after ? { id: { gt: opts.after } } : {}) },
    select: { id: true, readStatus: true, aiError: true },
    orderBy: { id: "asc" },
    take: opts.limit,
  });
  const out: SettleResult = { filed: 0, unsure: 0, deleted: 0, kept: 0, next: rows.length === opts.limit ? rows.at(-1)!.id : null };
  let done: string | null = null;
  for (const row of rows) {
    if (opts.deadlineAt && Date.now() >= opts.deadlineAt.getTime()) {
      out.next = done ?? opts.after ?? "";
      break;
    }
    // Filing can add a customer, supplier or year folder, which the next file may need.
    const fresh = await fileContext(prisma, ctx);
    if (row.readStatus === null && row.aiError) {
      // A read that failed: once more, now. Still busy or failed again → it stays, with "Try again with AI".
      const read = await retryRead(prisma, fresh, row.id)
        .then(() => readUpload(prisma, fresh, company, row.id))
        .catch((error: unknown) => (error instanceof UserError ? ({ status: "busy" } as const) : Promise.reject(error)));
      if (read.status === "busy" || (read.status === "not_read" && read.retryable)) {
        out.kept += 1;
        done = row.id;
        continue;
      }
    }
    const outcome = await autoFileAfterRead(prisma, await fileContext(prisma, ctx), company, row.id).catch((error: unknown) => {
      if (error instanceof UserError) return { action: "review", reason: error.message } as const;
      throw error;
    });
    if (outcome.action === "filed") out[outcome.unsure ? "unsure" : "filed"] += 1;
    else if (outcome.action === "deleted") out.deleted += 1;
    else out.kept += 1;
    done = row.id;
  }
  return out;
}
