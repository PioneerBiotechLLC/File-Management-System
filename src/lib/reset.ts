import type { Db } from "@/lib/db";
import { UserError } from "@/lib/errors";
import { checkBucket, removePrefix } from "@/lib/storage";

export type ResetResult = { files: number; objects: number; folders: number; parties: number };

/**
 * Back to before the first upload: every file (and its versions and stored bytes), every
 * customer and supplier, and the year / Customers / Suppliers / company / kind folders they
 * created. The company's own folders, people, grants, the log and the AI spend all stay.
 */
export async function resetFiles(prisma: Db, orgId: string, actorEmail: string): Promise<ResetResult> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } });
  if (!org) throw new UserError("No such company.");
  // Storage must be reachable before anything is deleted, or the bytes would be left behind.
  await checkBucket().catch((error: unknown) => {
    throw new UserError(`Storage is not reachable, so nothing was deleted: ${error instanceof Error ? error.message : String(error)}`);
  });

  const files = await prisma.storedFile.count({ where: { orgId } });
  // Versions go with their files (cascade); bytes are removed by prefix so staged uploads go too.
  await prisma.storedFile.deleteMany({ where: { orgId } });
  const objects = await removePrefix(`${orgId}/`);

  // Deepest first: a folder cannot be deleted while it has children.
  let folders = 0;
  for (const kind of ["doc", "party", "side", "year"] as const) {
    folders += (await prisma.folder.deleteMany({ where: { orgId, kind } })).count;
  }
  const parties = (await prisma.party.deleteMany({ where: { orgId } })).count;

  await prisma.auditLog.create({
    data: { orgId, userEmail: actorEmail, action: "org.reset", targetType: "organization", targetId: orgId, after: { files, objects, folders, parties } },
  });
  return { files, objects, folders, parties };
}
