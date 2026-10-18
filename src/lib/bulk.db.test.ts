import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { TEST_DATABASE_URL, freshDatabase } from "@/test/database";
import { addTestFolders } from "@/test/folders";

const stored = new Map<string, Uint8Array>();
const written = new Map<string, string>();
const analyzeFile = vi.fn();

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    presignUpload: async (key: string) => `https://bucket.test/put/${key}`,
    head: async (key: string) => (stored.has(key) ? { sizeBytes: stored.get(key)!.length, contentType: null } : null),
    getObject: async (key: string) => stored.get(key) ?? null,
    copy: async (from: string, to: string) => {
      stored.set(to, stored.get(from)!);
    },
    remove: async (key: string) => {
      stored.delete(key);
    },
    putObject: async (key: string, body: string) => {
      written.set(key, body);
    },
  };
});
vi.mock("@/lib/analysis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analysis")>();
  return { ...actual, analyzeFile: (...args: unknown[]) => analyzeFile(...args) };
});

const { createCompany } = await import("./companies");
const { addMember } = await import("./users");
const files = await import("./files");
const intake = await import("./intake");
const { autoFileAfterRead } = await import("./bulk");

const company = { name: "API Pharma", domain: "api-pharma.net", timezone: "Asia/Dubai" };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const folderFiling = (folderId: string | null, confidence: number) => ({
  placement: "folder" as const,
  side: null,
  partyId: null,
  partyName: null,
  materialId: null,
  materialName: null,
  docKind: null,
  folderId,
  confidence,
  reason: "Test",
});

describe.skipIf(!TEST_DATABASE_URL)("bulk upload: filing without confirmation (database)", () => {
  let prisma: PrismaClient;
  let drop: () => Promise<void>;
  let orgId: string;
  let adminId: string;
  const folder: Record<string, string> = {};

  const ctx = () => files.fileContext(prisma, { orgId, userId: adminId, email: "admin@api-pharma.net", role: "admin" });
  const fileRow = (id: string) => prisma.storedFile.findUniqueOrThrow({ where: { id } });

  /** Uploads a file and has the AI read it with the given filing answer. */
  async function uploadAndRead(name: string, filing: ReturnType<typeof folderFiling>) {
    const started = await files.startUpload(prisma, await ctx(), { name, size: name.length, mimeType: "application/pdf", sha256: sha(name), allowDuplicate: true });
    if (started.kind !== "upload") throw new Error("expected an upload");
    stored.set(`${orgId}/${started.fileId}/${started.versionNo}.upload`, new TextEncoder().encode(name));
    await files.confirmUpload(prisma, await ctx(), { fileId: started.fileId, versionNo: started.versionNo });
    analyzeFile.mockResolvedValueOnce({
      status: "analyzed",
      readStatus: "full",
      model: "m",
      analysis: { readable: true, problem: null, title: name, summary: "A document.", docType: "other", docDate: null, language: "en", facts: { parties: [], references: [], amounts: [], products: [] }, tags: [], filing },
    });
    expect(await intake.readUpload(prisma, await ctx(), company, started.fileId)).toEqual({ status: "read" });
    return started.fileId;
  }

  beforeAll(async () => {
    ({ prisma, drop } = await freshDatabase());
    orgId = (await createCompany(prisma, { slug: "api-pharma", name: company.name, domain: company.domain, actorEmail: "t" })).id;
    await addTestFolders(prisma, orgId);
    ({ userId: adminId } = await addMember(prisma, { orgId, email: "admin@api-pharma.net", role: "admin", actor: { email: "t" } }));
    for (const f of await prisma.folder.findMany({ where: { orgId }, include: { parent: true } })) {
      folder[f.parent ? `${f.parent.name}/${f.name}` : f.name] = f.id;
    }
  }, 60_000);

  afterAll(async () => drop?.());

  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    analyzeFile.mockReset();
  });

  it("files what the AI is at least 50% sure about where it said, and nothing is unsure", async () => {
    const fileId = await uploadAndRead("quote.pdf", folderFiling(folder["Sales/Quotations"]!, 0.5));
    expect(await autoFileAfterRead(prisma, await ctx(), company, fileId)).toMatchObject({ action: "filed", path: "Sales / Quotations", unsure: false });
    expect(await fileRow(fileId)).toMatchObject({ folderId: folder["Sales/Quotations"], status: "ready", unsure: false });
    // Filing also leaves the facts CSV beside the file in the bucket, with where it went.
    const csv = written.get(`${orgId}/${fileId}/facts.csv`)!;
    expect(csv.split("\r\n")[0]).toMatch(/^\uFEFFfile_id,file_name,title,document_type/);
    expect(csv).toContain(`${fileId},quote.pdf,quote.pdf,`);
    expect(csv).toContain(",Sales / Quotations,");
  });

  it("leaves anything under 50% in Review, wherever the AI thought it went", async () => {
    const fileId = await uploadAndRead("maybe.pdf", folderFiling(folder.General!, 0.49));
    expect(await autoFileAfterRead(prisma, await ctx(), company, fileId)).toEqual({ action: "review", reason: "The AI was only 49% sure it belongs in General." });
    expect(await fileRow(fileId)).toMatchObject({ folderId: null, status: "needs_review", unsure: false });
    expect((await files.listUnfiled(prisma, await ctx())).map((f) => f.id)).toContain(fileId);
  });

  it("puts a file with no place in the tree in General, marked unsure, until someone moves it", async () => {
    const fileId = await uploadAndRead("odd.pdf", folderFiling(folder.General!, 0.8));
    expect(await autoFileAfterRead(prisma, await ctx(), company, fileId)).toMatchObject({ action: "filed", path: "General", unsure: true });
    expect(await fileRow(fileId)).toMatchObject({ folderId: folder.General, unsure: true });

    await files.moveFile(prisma, await ctx(), { fileId, folderId: folder["Sales/Price Lists"]! });
    expect(await fileRow(fileId)).toMatchObject({ folderId: folder["Sales/Price Lists"], unsure: false });
  });

  it("sends a confident file whose place has since closed to General, unsure", async () => {
    const fileId = await uploadAndRead("delivery.pdf", folderFiling(folder["Logistics/Delivery Notes"]!, 0.9));
    await prisma.folder.update({ where: { id: folder["Logistics/Delivery Notes"]! }, data: { isActive: false } });
    try {
      expect(await autoFileAfterRead(prisma, await ctx(), company, fileId)).toMatchObject({ action: "filed", path: "General", unsure: true });
    } finally {
      await prisma.folder.update({ where: { id: folder["Logistics/Delivery Notes"]! }, data: { isActive: true } });
    }
  });

  it("keeps such a file in Review when there is no General folder", async () => {
    const fileId = await uploadAndRead("nowhere.pdf", folderFiling(folder["Logistics/Delivery Notes"]!, 0.9));
    await prisma.folder.update({ where: { id: folder["Logistics/Delivery Notes"]! }, data: { isActive: false } });
    await prisma.folder.update({ where: { id: folder.General! }, data: { name: "Misc", nameAr: null } });
    try {
      expect(await autoFileAfterRead(prisma, await ctx(), company, fileId)).toEqual({ action: "review", reason: "The AI found no place for it, and there is no General folder to put it in." });
    } finally {
      await prisma.folder.update({ where: { id: folder["Logistics/Delivery Notes"]! }, data: { isActive: true } });
      await prisma.folder.update({ where: { id: folder.General! }, data: { name: "General", nameAr: "عام" } });
    }
  });
});
