import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { TEST_DATABASE_URL, freshDatabase } from "@/test/database";

const removed: string[] = [];

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    remove: async (key: string) => {
      removed.push(key);
    },
  };
});

const { sweep } = await import("./sweep");

describe.skipIf(!TEST_DATABASE_URL)("sweep (database)", () => {
  let prisma: PrismaClient;
  let drop: () => Promise<void>;
  let orgId: string;
  let userId: string;

  const days = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

  async function file(data: { name: string; status?: "uploading" | "ready"; createdAt?: Date; deletedAt?: Date | null; versions?: { versionNo: number; createdAt: Date }[] }) {
    return prisma.storedFile.create({
      data: {
        orgId,
        name: data.name,
        originalName: data.name,
        mimeType: "application/pdf",
        sizeBytes: 1,
        sha256: data.name.padEnd(64, "0"),
        status: data.status ?? "ready",
        uploadedBy: userId,
        createdAt: data.createdAt,
        deletedAt: data.deletedAt ?? null,
        versions: { create: (data.versions ?? [{ versionNo: 1, createdAt: data.createdAt ?? new Date() }]).map((v) => ({ ...v, sizeBytes: 1, sha256: "x", uploadedBy: userId })) },
      },
      select: { id: true },
    });
  }

  beforeAll(async () => {
    ({ prisma, drop } = await freshDatabase());
    orgId = (await prisma.organization.create({ data: { slug: "sweep", name: "Sweep", domain: "sweep.example" } })).id;
    userId = (await prisma.appUser.create({ data: { email: "u@sweep.example" } })).id;
  }, 60_000);

  afterAll(async () => drop?.());

  it("drops abandoned uploads and versions, purges files deleted over 30 days ago, and leaves the rest", async () => {
    const abandoned = await file({ name: "abandoned.pdf", status: "uploading", createdAt: new Date(Date.now() - 60 * 60 * 1000) });
    const fresh = await file({ name: "fresh.pdf", status: "uploading" });
    const withPending = await file({ name: "pending-v2.pdf", versions: [{ versionNo: 1, createdAt: days(2) }, { versionNo: 2, createdAt: days(1) }] });
    const expired = await file({ name: "expired.pdf", deletedAt: days(31), versions: [{ versionNo: 1, createdAt: days(40) }, { versionNo: 2, createdAt: days(35) }] });
    await prisma.storedFile.update({ where: { id: expired.id }, data: { currentVersion: 2 } });
    const recent = await file({ name: "recent.pdf", deletedAt: days(5) });

    expect(await sweep(prisma)).toEqual({ abandonedUploads: 1, abandonedVersions: 1, purged: 1 });

    const remaining = (await prisma.storedFile.findMany({ where: { orgId }, select: { id: true } })).map((f) => f.id);
    expect(remaining).not.toContain(abandoned.id);
    expect(remaining).not.toContain(expired.id);
    expect(remaining).toEqual(expect.arrayContaining([fresh.id, withPending.id, recent.id]));
    expect((await prisma.fileVersion.findMany({ where: { fileId: withPending.id } })).map((v) => v.versionNo)).toEqual([1]);

    expect(removed).toContain(`${orgId}/${abandoned.id}/1.upload`);
    expect(removed).toContain(`${orgId}/${withPending.id}/2.upload`);
    expect(removed).toContain(`${orgId}/${expired.id}/1`);
    expect(removed).toContain(`${orgId}/${expired.id}/2`);
    expect(removed.some((k) => k.includes(recent.id) || k.includes(fresh.id))).toBe(false);
    expect(await prisma.auditLog.findFirst({ where: { action: "file.purge", targetId: expired.id } })).toMatchObject({ orgId, userEmail: "system", before: { name: "expired.pdf" } });

    // Nothing left to do.
    expect(await sweep(prisma)).toEqual({ abandonedUploads: 0, abandonedVersions: 0, purged: 0 });
  });
});
