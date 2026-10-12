import type { Db } from "@/lib/db";
import { TRASH_DAYS, UPLOAD_WINDOW_MS } from "@/lib/files";
import { objectKey, remove, uploadKey } from "@/lib/storage";

/**
 * Housekeeping, run daily by /api/cron/sweep: drops uploads that were started and never
 * confirmed, and removes files for good 30 days after they were deleted. Objects go first, then
 * rows, so nothing in the bucket is ever left without a row that can find it again.
 */

/** Per run, so one run stays well inside a function's time limit; the next run continues. */
const BATCH = 200;

export type SweepResult = { abandonedUploads: number; abandonedVersions: number; purged: number };

const quietly = (promise: Promise<unknown>) => promise.catch(() => undefined);

export async function sweep(prisma: Db, now = new Date()): Promise<SweepResult> {
  const result: SweepResult = { abandonedUploads: 0, abandonedVersions: 0, purged: 0 };
  const uploadCutoff = new Date(now.getTime() - UPLOAD_WINDOW_MS);

  // Files whose first upload never finished: nothing but a row and perhaps a staging object.
  const abandoned = await prisma.storedFile.findMany({
    where: { status: "uploading", createdAt: { lt: uploadCutoff } },
    select: { id: true, orgId: true },
    take: BATCH,
  });
  for (const file of abandoned) {
    await quietly(remove(uploadKey(file.orgId, file.id, 1)));
    await prisma.storedFile.delete({ where: { id: file.id } });
    result.abandonedUploads += 1;
  }

  // New versions that were started and never confirmed.
  const versions = await prisma.fileVersion.findMany({
    where: { createdAt: { lt: uploadCutoff }, file: { status: { not: "uploading" } } },
    select: { id: true, versionNo: true, file: { select: { id: true, orgId: true, currentVersion: true } } },
    take: BATCH * 5,
  });
  for (const v of versions) {
    if (v.versionNo <= v.file.currentVersion) continue;
    await quietly(remove(uploadKey(v.file.orgId, v.file.id, v.versionNo)));
    await prisma.fileVersion.delete({ where: { id: v.id } });
    result.abandonedVersions += 1;
  }

  // Deleted files past their 30 days: every version's bytes, then the row (versions cascade).
  const expired = await prisma.storedFile.findMany({
    where: { deletedAt: { lt: new Date(now.getTime() - TRASH_DAYS * 24 * 60 * 60 * 1000) } },
    select: { id: true, orgId: true, name: true, folderId: true, deletedAt: true, versions: { select: { versionNo: true } } },
    take: BATCH,
  });
  for (const file of expired) {
    for (const v of file.versions) {
      await remove(objectKey(file.orgId, file.id, v.versionNo));
      await quietly(remove(uploadKey(file.orgId, file.id, v.versionNo)));
    }
    await prisma.$transaction([
      prisma.storedFile.delete({ where: { id: file.id } }),
      prisma.auditLog.create({
        data: {
          orgId: file.orgId,
          userEmail: "system",
          action: "file.purge",
          targetType: "file",
          targetId: file.id,
          before: { name: file.name, folderId: file.folderId, deletedAt: file.deletedAt?.toISOString() ?? null },
        },
      }),
    ]);
    result.purged += 1;
  }

  return result;
}
