import type { Db } from "@/lib/db";
import { DEFAULT_FOLDERS, seedDefaultFolders } from "@/lib/folders";
import { setFolderActive } from "@/lib/folder-admin";

/**
 * One-time move from the first folder tree (Sales, Purchasing, Logistics, Finance…) to the
 * current one: company folders beside year folders. Safe to run again.
 * - Finance / Bank moves to the top level, keeping its access grants and files.
 * - Missing company folders are created, and existing ones get the current descriptions.
 * - The old trading folders are deactivated: their files stay readable and searchable, and
 *   people move them into the year folders when convenient.
 */

/** Old folders whose documents now live under years. */
const RETIRED = ["Sales", "Purchasing", "Logistics", "Finance", "Quality & Regulatory / Certificates of Analysis"];

export type RestructureResult = { created: number; bankMoved: boolean; retired: string[]; filesInRetired: number };

export async function restructureFolders(prisma: Db, orgId: string, actorEmail: string): Promise<RestructureResult> {
  const actor = { orgId, email: actorEmail };
  const load = () => prisma.folder.findMany({ where: { orgId }, select: { id: true, parentId: true, name: true, isActive: true } });
  let folders = await load();
  const byPath = () => {
    const byId = new Map(folders.map((f) => [f.id, f]));
    const path = (f: (typeof folders)[number]): string => (f.parentId && byId.get(f.parentId) ? `${path(byId.get(f.parentId)!)} / ${f.name}` : f.name);
    return new Map(folders.map((f) => [path(f), f]));
  };

  // Bank to the top, before seeding, so its grants and files come with it.
  let bankMoved = false;
  const oldBank = byPath().get("Finance / Bank");
  if (oldBank && !byPath().get("Bank")) {
    await prisma.$transaction([
      prisma.folder.update({ where: { id: oldBank.id }, data: { parentId: null, isActive: true } }),
      prisma.auditLog.create({
        data: { orgId, userEmail: actorEmail, action: "folder.update", targetType: "folder", targetId: oldBank.id, before: { parentId: oldBank.parentId }, after: { parentId: null } },
      }),
    ]);
    bankMoved = true;
  }

  const created = await seedDefaultFolders(prisma, orgId, actorEmail);
  folders = await load();

  // Current descriptions, which the AI files by.
  const paths = byPath();
  const walk = async (list: typeof DEFAULT_FOLDERS, parent: string | null) => {
    for (const d of list) {
      const path = parent ? `${parent} / ${d.name}` : d.name;
      const row = paths.get(path);
      if (row) await prisma.folder.update({ where: { id: row.id }, data: { description: d.description } });
      if (d.children) await walk(d.children, path);
    }
  };
  await walk(DEFAULT_FOLDERS, null);

  const retired: string[] = [];
  const retiredIds: string[] = [];
  for (const path of RETIRED) {
    const row = paths.get(path);
    if (!row) continue;
    if (row.isActive) {
      await setFolderActive(prisma, actor, row.id, false);
      retired.push(path);
    }
    retiredIds.push(row.id);
  }

  // Files still in the old folders, including their subfolders.
  folders = await load();
  const inRetired = new Set(retiredIds);
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of folders) {
      if (f.parentId && inRetired.has(f.parentId) && !inRetired.has(f.id)) {
        inRetired.add(f.id);
        grew = true;
      }
    }
  }
  const filesInRetired = await prisma.storedFile.count({ where: { orgId, deletedAt: null, folderId: { in: [...inRetired] } } });
  return { created, bankMoved, retired, filesInRetired };
}
