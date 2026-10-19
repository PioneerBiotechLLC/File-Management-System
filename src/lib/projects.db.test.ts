import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { TEST_DATABASE_URL, freshDatabase } from "@/test/database";

const stored = new Map<string, number>();

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    presignUpload: async (key: string) => `https://bucket.test/put/${key}`,
    head: async (key: string) => (stored.has(key) ? { sizeBytes: stored.get(key)!, contentType: null } : null),
    copy: async (from: string, to: string) => void stored.set(to, stored.get(from)!),
    remove: async (key: string) => void stored.delete(key),
    putObject: async () => undefined,
  };
});

const { createCompany } = await import("./companies");
const { addMember } = await import("./users");
const files = await import("./files");
const { ensureProjectFolders } = await import("./projects");
const { folderChoices } = await import("./intake");
const { createFolder } = await import("./folder-admin");
const { UserError } = await import("./errors");

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe.skipIf(!TEST_DATABASE_URL)("project uploads (database)", () => {
  let prisma: PrismaClient;
  let drop: () => Promise<void>;
  let orgId: string;
  const ids: Record<string, string> = {};
  const ctxFor = (who: "admin" | "sara") => files.fileContext(prisma, { orgId, userId: ids[who]!, email: `${who}@api-pharma.net`, role: who === "admin" ? "admin" : "editor" });

  /** Uploads one file straight into a folder, as the project page does. */
  async function upload(folderId: string, name: string, content: string) {
    const ctx = await ctxFor("admin");
    const started = await files.startUpload(prisma, ctx, { name, size: content.length, mimeType: "application/pdf", sha256: sha(content), folderId, allowDuplicate: false, duplicatesIn: "folder" });
    if (started.kind === "duplicate") return started;
    stored.set(`${orgId}/${started.fileId}/${started.versionNo}.upload`, content.length);
    return files.confirmUpload(prisma, ctx, { fileId: started.fileId, versionNo: started.versionNo });
  }

  beforeAll(async () => {
    ({ prisma, drop } = await freshDatabase());
    orgId = (await createCompany(prisma, { slug: "api-pharma", name: "API Pharma", domain: "api-pharma.net", actorEmail: "t" })).id;
    ({ userId: ids.admin! } = await addMember(prisma, { orgId, email: "admin@api-pharma.net", role: "admin", actor: { email: "t" } }));
    ({ userId: ids.sara! } = await addMember(prisma, { orgId, email: "sara@api-pharma.net", role: "editor", actor: { email: "t" } }));
  }, 60_000);

  afterAll(async () => drop?.());

  it("creates Projects and the picked folder's tree once, matching existing folders whatever the case", async () => {
    const admin = await ctxFor("admin");
    const first = await ensureProjectFolders(prisma, admin, { parentId: null, paths: ["Sharjah Plant", "Sharjah Plant/Drawings", "Sharjah Plant/Drawings/Rev 2"] });
    const again = await ensureProjectFolders(prisma, admin, { parentId: null, paths: ["sharjah plant/DRAWINGS", "Sharjah Plant/BOQ"] });
    expect(again["sharjah plant/DRAWINGS"]).toBe(first["Sharjah Plant/Drawings"]);

    const rows = await prisma.folder.findMany({ where: { orgId, kind: "project" }, include: { parent: true } });
    expect(rows.map((f) => `${f.parent?.name ?? ""}/${f.name}`).sort()).toEqual(["/Projects", "Drawings/Rev 2", "Projects/Sharjah Plant", "Sharjah Plant/BOQ", "Sharjah Plant/Drawings"]);
    // One log entry per call that made folders: 4 the first time (with Projects), 1 the second.
    const logs = await prisma.auditLog.findMany({ where: { orgId, action: "folder.import" }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => (l.after as { created: number }).created)).toEqual([4, 1]);

    await expect(ensureProjectFolders(prisma, await ctxFor("sara"), { parentId: null, paths: ["X"] })).rejects.toThrow(UserError);
    const hr = (await prisma.folder.findFirstOrThrow({ where: { orgId, name: "HR", parentId: null } })).id;
    await expect(ensureProjectFolders(prisma, admin, { parentId: hr, paths: ["X"] })).rejects.toThrow(/Choose Projects/);
  });

  it("files uploads straight into the project folder, without the AI, and skips only copies already in that folder", async () => {
    const admin = await ctxFor("admin");
    const { "Sharjah Plant/Drawings": drawings, "Sharjah Plant/BOQ": boq } = await ensureProjectFolders(prisma, admin, { parentId: null, paths: ["Sharjah Plant/Drawings", "Sharjah Plant/BOQ"] });

    const done = await upload(drawings!, "plan.pdf", "plan v1");
    expect(done).toMatchObject({ status: "ready", folderPath: "Projects / Sharjah Plant / Drawings" });
    const row = await prisma.storedFile.findFirstOrThrow({ where: { orgId, name: "plan.pdf" } });
    expect(row).toMatchObject({ folderId: drawings, status: "ready", readStatus: null, summaryConfirmedAt: null });
    expect(await prisma.aiUsage.count({ where: { orgId } })).toBe(0);

    // The same file in another project folder is kept as its own copy; in the same folder it is skipped.
    expect(await upload(boq!, "plan copy.pdf", "plan v1")).toMatchObject({ status: "ready" });
    expect(await upload(drawings!, "plan again.pdf", "plan v1")).toMatchObject({ kind: "duplicate", existing: { name: "plan.pdf" } });

    // Findable by name, like any filed file.
    const vector = await prisma.$queryRaw<{ v: string | null }[]>`SELECT "searchVector"::text AS v FROM "StoredFile" WHERE "id" = ${row.id}`;
    expect(vector[0]!.v).toContain("plan");
  });

  it("never offers project folders to the AI, and keeps a folder made inside a project part of it", async () => {
    const admin = await ctxFor("admin");
    const offered = folderChoices(admin).map((f) => f.path);
    expect(offered.some((p) => p.startsWith("Projects"))).toBe(false);
    expect(offered).toContain("General");

    const project = (await prisma.folder.findFirstOrThrow({ where: { orgId, name: "Sharjah Plant" } })).id;
    const made = await createFolder(prisma, { orgId, email: "admin@api-pharma.net" }, { name: "Handover", nameAr: "", description: "", access: "everyone", parentId: project });
    expect((await prisma.folder.findUniqueOrThrow({ where: { id: made.id } })).kind).toBe("project");
  });
});
