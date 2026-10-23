import { z } from "zod";
import type { Db } from "@/lib/db";
import { UserError } from "@/lib/errors";

/** Admin-only folder changes. Callers check the permission; every change is audited here. */

type Actor = { orgId: string; email: string };

const MAX_DEPTH = 5;

const folderFields = z.object({
  name: z.string().trim().min(1, "Give the folder a name.").max(100, "That name is too long."),
  nameAr: z.string().trim().max(100).transform((v) => v || null),
  description: z.string().trim().max(500, "Keep the description under 500 characters.").transform((v) => v || null),
  access: z.enum(["everyone", "restricted"]),
  parentId: z.string().min(1).nullable(),
});

type FolderInput = z.input<typeof folderFields>;

type FolderRow = { id: string; parentId: string | null; name: string; access: "everyone" | "restricted"; isActive: boolean; kind: string };

async function orgFolders(prisma: Db, orgId: string): Promise<FolderRow[]> {
  return prisma.folder.findMany({ where: { orgId }, select: { id: true, parentId: true, name: true, access: true, isActive: true, kind: true } });
}

/** Year, customer, supplier and technical folders are created and kept by the app, never edited here. */
function checkRegular(folder: FolderRow) {
  if (folder.kind !== "regular") throw new UserError("That folder is managed by the app and cannot be changed from Settings.");
}

/** The folder and everything under it. */
function subtreeIds(folders: FolderRow[], rootId: string): Set<string> {
  const ids = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {
        ids.add(f.id);
        grew = true;
      }
    }
  }
  return ids;
}

function depthOf(folders: FolderRow[], id: string | null): number {
  const byId = new Map(folders.map((f) => [f.id, f]));
  let depth = 0;
  for (let f = id ? byId.get(id) : undefined; f && depth <= MAX_DEPTH + 1; f = f.parentId ? byId.get(f.parentId) : undefined) depth += 1;
  return depth;
}

function checkParent(folders: FolderRow[], parentId: string | null, movingId?: string) {
  if (parentId === null) return;
  const parent = folders.find((f) => f.id === parentId);
  if (!parent) throw new UserError("That parent folder does not exist.");
  if (parent.kind !== "regular") throw new UserError("A folder cannot go inside a year, customer, supplier or technical folder; those are managed by the app.");
  if (movingId && subtreeIds(folders, movingId).has(parentId)) throw new UserError("A folder cannot be moved into itself or one of its subfolders.");
  if (depthOf(folders, parentId) >= MAX_DEPTH) throw new UserError(`Folders can be nested ${MAX_DEPTH} levels deep at most.`);
}

function checkUnique(folders: FolderRow[], parentId: string | null, name: string, exceptId?: string) {
  const clash = folders.find((f) => f.parentId === parentId && f.name.toLowerCase() === name.toLowerCase() && f.id !== exceptId);
  if (clash) throw new UserError(`There is already a folder called "${clash.name}" there.`);
}

function parseFolder(input: FolderInput) {
  const parsed = folderFields.safeParse(input);
  if (!parsed.success) throw new UserError(parsed.error.issues[0]?.message ?? "Check the folder details.");
  return parsed.data;
}

export async function createFolder(prisma: Db, actor: Actor, input: FolderInput): Promise<{ id: string }> {
  const data = parseFolder(input);
  const folders = await orgFolders(prisma, actor.orgId);
  checkParent(folders, data.parentId);
  checkUnique(folders, data.parentId, data.name);
  const siblings = folders.filter((f) => f.parentId === data.parentId).length;
  return prisma.$transaction(async (tx) => {
    const folder = await tx.folder.create({
      data: { ...data, orgId: actor.orgId, sortOrder: siblings, createdBy: actor.email },
      select: { id: true },
    });
    await tx.auditLog.create({
      data: { orgId: actor.orgId, userEmail: actor.email, action: "folder.create", targetType: "folder", targetId: folder.id, after: data },
    });
    return folder;
  });
}

/** Renames, describes, restricts or moves a folder. Its files and subfolders stay inside it. */
export async function updateFolder(prisma: Db, actor: Actor, folderId: string, input: FolderInput): Promise<void> {
  const data = parseFolder(input);
  const folders = await orgFolders(prisma, actor.orgId);
  const folder = folders.find((f) => f.id === folderId);
  if (!folder) throw new UserError("That folder does not exist.");
  checkRegular(folder);
  checkParent(folders, data.parentId, folderId);
  checkUnique(folders, data.parentId, data.name, folderId);
  await prisma.$transaction(async (tx) => {
    const before = await tx.folder.findUniqueOrThrow({
      where: { id: folderId },
      select: { name: true, nameAr: true, description: true, access: true, parentId: true },
    });
    await tx.folder.update({ where: { id: folderId }, data });
    await tx.auditLog.create({
      data: { orgId: actor.orgId, userEmail: actor.email, action: "folder.update", targetType: "folder", targetId: folderId, before, after: data },
    });
  });
}

/**
 * Hides a folder and its subfolders from the tree and stops new files going in; existing files stay
 * readable. A folder that held files is never deleted. Reactivating needs an active parent.
 */
export async function setFolderActive(prisma: Db, actor: Actor, folderId: string, active: boolean): Promise<void> {
  const folders = await orgFolders(prisma, actor.orgId);
  const folder = folders.find((f) => f.id === folderId);
  if (!folder) throw new UserError("That folder does not exist.");
  checkRegular(folder);
  if (active && folder.parentId && !folders.find((f) => f.id === folder.parentId)?.isActive) {
    throw new UserError("Reactivate the parent folder first.");
  }
  const ids = active ? [folderId] : [...subtreeIds(folders, folderId)];
  await prisma.$transaction(async (tx) => {
    await tx.folder.updateMany({ where: { orgId: actor.orgId, id: { in: ids } }, data: { isActive: active } });
    await tx.auditLog.create({
      data: {
        orgId: actor.orgId,
        userEmail: actor.email,
        action: active ? "folder.activate" : "folder.deactivate",
        targetType: "folder",
        targetId: folderId,
        after: { folders: ids.length },
      },
    });
  });
}

export async function listGrants(prisma: Db, orgId: string, folderId: string) {
  return prisma.folderGrant.findMany({
    where: { folderId, folder: { orgId } },
    select: { userId: true, canWrite: true, user: { select: { email: true, name: true } } },
    orderBy: { user: { email: "asc" } },
  });
}

/** Lets a company member see (and optionally write in) a restricted folder and everything under it. */
export async function grantAccess(
  prisma: Db,
  actor: Actor,
  input: { folderId: string; userId: string; canWrite: boolean },
): Promise<void> {
  const [folder, member] = await Promise.all([
    prisma.folder.findFirst({ where: { id: input.folderId, orgId: actor.orgId }, select: { id: true } }),
    prisma.membership.findUnique({
      where: { userId_orgId: { userId: input.userId, orgId: actor.orgId } },
      select: { user: { select: { email: true } } },
    }),
  ]);
  if (!folder) throw new UserError("That folder does not exist.");
  if (!member) throw new UserError("Add that person to the company first (Settings → Users).");
  await prisma.$transaction(async (tx) => {
    await tx.folderGrant.upsert({
      where: { folderId_userId: { folderId: input.folderId, userId: input.userId } },
      create: { folderId: input.folderId, userId: input.userId, canWrite: input.canWrite },
      update: { canWrite: input.canWrite },
    });
    await tx.auditLog.create({
      data: {
        orgId: actor.orgId,
        userEmail: actor.email,
        action: "folder.grant",
        targetType: "folder",
        targetId: input.folderId,
        after: { user: member.user.email, canWrite: input.canWrite },
      },
    });
  });
}

export async function revokeAccess(prisma: Db, actor: Actor, input: { folderId: string; userId: string }): Promise<void> {
  const grant = await prisma.folderGrant.findFirst({
    where: { folderId: input.folderId, userId: input.userId, folder: { orgId: actor.orgId } },
    select: { id: true, user: { select: { email: true } } },
  });
  if (!grant) return;
  await prisma.$transaction(async (tx) => {
    await tx.folderGrant.delete({ where: { id: grant.id } });
    await tx.auditLog.create({
      data: { orgId: actor.orgId, userEmail: actor.email, action: "folder.revoke", targetType: "folder", targetId: input.folderId, before: { user: grant.user.email } },
    });
  });
}
