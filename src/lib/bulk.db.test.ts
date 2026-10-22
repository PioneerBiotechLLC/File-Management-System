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
const { autoFileAfterRead, reviewToSettle, settleReview } = await import("./bulk");

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

  async function upload(name: string) {
    const started = await files.startUpload(prisma, await ctx(), { name, size: name.length, mimeType: "application/pdf", sha256: sha(name), allowDuplicate: true });
    if (started.kind !== "upload") throw new Error("expected an upload");
    stored.set(`${orgId}/${started.fileId}/${started.versionNo}.upload`, new TextEncoder().encode(name));
    await files.confirmUpload(prisma, await ctx(), { fileId: started.fileId, versionNo: started.versionNo });
    return started.fileId;
  }

  /** Uploads a file and has the AI read it with the given filing answer. */
  async function uploadAndRead(name: string, filing: ReturnType<typeof folderFiling>) {
    const fileId = await upload(name);
    analyzeFile.mockResolvedValueOnce({
      status: "analyzed",
      readStatus: "full",
      model: "m",
      analysis: { readable: true, problem: null, title: name, summary: "A document.", docType: "other", docDate: null, language: "en", facts: { parties: [], references: [], amounts: [], products: [] }, tags: [], filing },
    });
    expect(await intake.readUpload(prisma, await ctx(), company, fileId)).toEqual({ status: "read" });
    return fileId;
  }

  /** Uploads a file the AI cannot read. */
  async function uploadUnreadable(name: string) {
    const fileId = await upload(name);
    analyzeFile.mockResolvedValueOnce({ status: "not_read", reason: "The file is empty." });
    expect(await intake.readUpload(prisma, await ctx(), company, fileId)).toMatchObject({ status: "not_read", retryable: false });
    return fileId;
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

  it("files what the AI is at least 60% sure about where it said, and nothing is unsure", async () => {
    const fileId = await uploadAndRead("quote.pdf", folderFiling(folder["Sales/Quotations"]!, 0.6));
    expect(await autoFileAfterRead(prisma, await ctx(), company, fileId)).toMatchObject({ action: "filed", path: "Sales / Quotations", unsure: false });
    expect(await fileRow(fileId)).toMatchObject({ folderId: folder["Sales/Quotations"], status: "ready", unsure: false });
    // Filing also leaves the facts CSV beside the file in the bucket, with where it went.
    const csv = written.get(`${orgId}/${fileId}/facts.csv`)!;
    expect(csv.split("\r\n")[0]).toMatch(/^\uFEFFfile_id,file_name,title,document_type/);
    expect(csv).toContain(`${fileId},quote.pdf,quote.pdf,`);
    expect(csv).toContain(",Sales / Quotations,");
  });

  it("puts anything under 60% in General, marked unsure, wherever the AI thought it went", async () => {
    const fileId = await uploadAndRead("maybe.pdf", folderFiling(folder["Sales/Quotations"]!, 0.59));
    expect(await autoFileAfterRead(prisma, await ctx(), company, fileId)).toMatchObject({ action: "filed", path: "General", confidence: 0.59, unsure: true });
    expect(await fileRow(fileId)).toMatchObject({ folderId: folder.General, status: "ready", unsure: true });
    expect((await files.listUnfiled(prisma, await ctx())).map((f) => f.id)).not.toContain(fileId);
  });

  it("deletes a file the AI cannot read, which can be restored", async () => {
    const fileId = await uploadUnreadable("empty.pdf");
    expect(await autoFileAfterRead(prisma, await ctx(), company, fileId)).toEqual({ action: "deleted", reason: "The AI could not read it: The file is empty." });
    expect(await fileRow(fileId)).toMatchObject({ deletedAt: expect.any(Date) });
    expect(await prisma.auditLog.count({ where: { orgId, action: "file.delete", targetId: fileId } })).toBe(1);
    await files.restoreFile(prisma, await ctx(), { fileId });
    expect(await fileRow(fileId)).toMatchObject({ deletedAt: null, status: "needs_review" });
  });

  it("files a file too large for the AI in General under its own name, and keeps a failed read in Review", async () => {
    vi.stubEnv("FILES_AI_MAX_MB", "1");
    const big = await upload("big.pdf");
    await prisma.storedFile.update({ where: { id: big }, data: { status: "needs_review", readStatus: "not_read", sizeBytes: 2 * 1024 * 1024, aiError: "The file is larger than 1 MB, the most the AI reads." } });
    expect(await autoFileAfterRead(prisma, await ctx(), company, big)).toMatchObject({ action: "filed", path: "General", confidence: 0, unsure: true });
    expect(await fileRow(big)).toMatchObject({ folderId: folder.General, status: "ready", unsure: true, title: "big.pdf", summary: expect.stringContaining("larger than 1 MB") });
    expect(await prisma.auditLog.findFirst({ where: { targetId: big, action: "file.summary" } })).toMatchObject({ after: { source: "name", auto: true } });

    const failed = await upload("failed.pdf");
    analyzeFile.mockRejectedValueOnce(new Error("overloaded"));
    expect(await intake.readUpload(prisma, await ctx(), company, failed)).toMatchObject({ status: "not_read", retryable: true });
    expect(await autoFileAfterRead(prisma, await ctx(), company, failed)).toMatchObject({ action: "review" });
    expect(await fileRow(failed)).toMatchObject({ folderId: null, deletedAt: null });
    await prisma.storedFile.update({ where: { id: failed }, data: { deletedAt: new Date() } });
  });

  it("clears Review in steps: files what was read or is too large, deletes what cannot be read, retries a failed read, keeps the rest", async () => {
    vi.stubEnv("FILES_AI_MAX_MB", "1");
    // What earlier runs left in Review.
    await prisma.storedFile.updateMany({ where: { orgId, folderId: null, deletedAt: null }, data: { deletedAt: new Date() } });
    const sure = await uploadAndRead("sure.pdf", folderFiling(folder["Sales/Quotations"]!, 0.9));
    const unsure = await uploadAndRead("unsure.pdf", folderFiling(folder["Sales/Quotations"]!, 0.3));
    const unreadable = await uploadUnreadable("blank.pdf");
    const big = await upload("huge.pdf");
    await prisma.storedFile.update({ where: { id: big }, data: { status: "needs_review", readStatus: "not_read", sizeBytes: 2 * 1024 * 1024, aiError: "Too large" } });
    // A read that failed earlier works this time.
    const failed = await upload("failed-once.pdf");
    analyzeFile.mockRejectedValueOnce(new Error("overloaded"));
    expect(await intake.readUpload(prisma, await ctx(), company, failed)).toMatchObject({ status: "not_read", retryable: true });
    // Someone has started on this one; it is theirs to finish.
    const started = await uploadAndRead("started.pdf", folderFiling(folder["Sales/Quotations"]!, 0.3));
    await prisma.storedFile.update({ where: { id: started }, data: { summaryConfirmedAt: new Date() } });

    expect(await reviewToSettle(prisma, orgId)).toEqual({ toFile: 3, toDelete: 1, toRetry: 1 });
    analyzeFile.mockResolvedValueOnce({
      status: "analyzed",
      readStatus: "full",
      model: "m",
      analysis: { readable: true, problem: null, title: "Second time", summary: "A document.", docType: "other", docDate: null, language: "en", facts: { parties: [], references: [], amounts: [], products: [] }, tags: [], filing: folderFiling(folder["Sales/Quotations"]!, 0.9) },
    });
    // Out of time at once: nothing is done, and the next call starts from the beginning.
    expect(await settleReview(prisma, await ctx(), company, { limit: 2, deadlineAt: new Date(Date.now() - 1) })).toEqual({ filed: 0, unsure: 0, deleted: 0, kept: 0, next: "" });
    const first = await settleReview(prisma, await ctx(), company, { limit: 2 });
    expect(first.next).not.toBeNull();
    const second = await settleReview(prisma, await ctx(), company, { after: first.next, limit: 2 });
    const third = second.next === null ? { filed: 0, unsure: 0, deleted: 0, kept: 0, next: null } : await settleReview(prisma, await ctx(), company, { after: second.next, limit: 2 });
    expect(third.next).toBeNull();
    const sum = (k: "filed" | "unsure" | "deleted" | "kept") => first[k] + second[k] + third[k];
    expect([sum("filed"), sum("unsure"), sum("deleted"), sum("kept")]).toEqual([2, 2, 1, 0]);

    expect(await fileRow(sure)).toMatchObject({ folderId: folder["Sales/Quotations"], unsure: false });
    expect(await fileRow(unsure)).toMatchObject({ folderId: folder.General, unsure: true });
    expect(await fileRow(unreadable)).toMatchObject({ deletedAt: expect.any(Date) });
    expect(await fileRow(big)).toMatchObject({ folderId: folder.General, unsure: true, title: "huge.pdf" });
    expect(await fileRow(failed)).toMatchObject({ folderId: folder["Sales/Quotations"], title: "Second time", status: "ready" });
    expect(await fileRow(started)).toMatchObject({ folderId: null, deletedAt: null });
    expect(await reviewToSettle(prisma, orgId)).toEqual({ toFile: 0, toDelete: 0, toRetry: 0 });
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
      expect(await autoFileAfterRead(prisma, await ctx(), company, fileId)).toEqual({ action: "review", reason: "The AI found no place for it. There is no General folder to put it in." });
    } finally {
      await prisma.folder.update({ where: { id: folder["Logistics/Delivery Notes"]! }, data: { isActive: true } });
      await prisma.folder.update({ where: { id: folder.General! }, data: { name: "General", nameAr: "عام" } });
    }
  });
});
