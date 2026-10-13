import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { TEST_DATABASE_URL, freshDatabase } from "@/test/database";
import { addTestFolders } from "@/test/folders";

const stored = new Map<string, Uint8Array>();
const analyzeFile = vi.fn();
const suggestFolder = vi.fn();

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    presignUpload: async (key: string) => `https://bucket.test/put/${key}`,
    presignDownload: async (key: string) => `https://bucket.test/get/${key}`,
    head: async (key: string) => (stored.has(key) ? { sizeBytes: stored.get(key)!.length, contentType: null } : null),
    getObject: async (key: string) => stored.get(key) ?? null,
    copy: async (from: string, to: string) => {
      if (!stored.has(from)) throw new Error(`no object at ${from}`);
      stored.set(to, stored.get(from)!);
    },
    remove: async (key: string) => {
      stored.delete(key);
    },
  };
});
vi.mock("@/lib/analysis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analysis")>();
  return { ...actual, analyzeFile: (...args: unknown[]) => analyzeFile(...args) };
});
vi.mock("@/lib/filing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/filing")>();
  return { ...actual, suggestFolder: (...args: unknown[]) => suggestFolder(...args) };
});

const { createCompany } = await import("./companies");
const { addMember } = await import("./users");
const files = await import("./files");
const intake = await import("./intake");
const { UserError } = await import("./errors");

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const company = { name: "API Pharma", domain: "api-pharma.net", timezone: "Asia/Dubai" };

/** A filing answer that names a company folder. */
const folderFiling = (folderId: string | null | undefined, confidence: number, reason: string) => ({
  placement: "folder" as const,
  side: null,
  partyId: null,
  partyName: null,
  docKind: null,
  folderId: folderId ?? null,
  confidence,
  reason,
});

const analysis = (overrides: Record<string, unknown> = {}) => ({
  readable: true,
  problem: null,
  title: "Quotation QT-2291",
  summary: "Quotation for insulin glargine to Gulf Pharmacy, 1,250.50 AED, dated 15 March 2026.",
  docType: "quotation",
  docDate: new Date("2026-03-15T00:00:00Z"),
  language: "en",
  facts: { parties: ["API Pharma", "Gulf Pharmacy"], references: [{ kind: "quotation", value: "QT-2291" }], amounts: [{ value: 1250.5, currency: "AED" }], products: ["Insulin glargine 100 IU/ml"] },
  tags: ["gulf pharmacy", "insulin"],
  filing: folderFiling(null, 0, "Quotation we sent to a customer"),
  ...overrides,
});

describe.skipIf(!TEST_DATABASE_URL)("intake: AI reading, summary confirmation and filing (database)", () => {
  let prisma: PrismaClient;
  let drop: () => Promise<void>;
  let orgId: string;
  const ids: Record<string, string> = {};
  const folder: Record<string, string> = {};

  const ctxFor = (who: "admin" | "sara") => files.fileContext(prisma, { orgId, userId: ids[who]!, email: `${who}@api-pharma.net`, role: who === "admin" ? "admin" : "editor" });

  /** Uploads as the browser would: start, PUT, confirm. The file is then waiting for the AI. */
  async function upload(who: "admin" | "sara", name: string, content: string) {
    const ctx = await ctxFor(who);
    const started = await files.startUpload(prisma, ctx, { name, size: content.length, mimeType: "application/pdf", sha256: sha(content), allowDuplicate: true });
    if (started.kind !== "upload") throw new Error("expected an upload");
    stored.set(`${orgId}/${started.fileId}/${started.versionNo}.upload`, new TextEncoder().encode(content));
    const done = await files.confirmUpload(prisma, ctx, { fileId: started.fileId, versionNo: started.versionNo });
    expect(done.status).toBe("processing");
    return done.fileId;
  }

  const fileRow = (id: string) => prisma.storedFile.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    ({ prisma, drop } = await freshDatabase());
    orgId = (await createCompany(prisma, { slug: "api-pharma", name: company.name, domain: company.domain, actorEmail: "t" })).id;
    await addTestFolders(prisma, orgId);
    ({ userId: ids.admin! } = await addMember(prisma, { orgId, email: "admin@api-pharma.net", role: "admin", actor: { email: "t" } }));
    ({ userId: ids.sara! } = await addMember(prisma, { orgId, email: "sara@api-pharma.net", role: "editor", actor: { email: "t" } }));
    for (const f of await prisma.folder.findMany({ where: { orgId }, include: { parent: true } })) {
      folder[f.parent ? `${f.parent.name}/${f.name}` : f.name] = f.id;
    }
  }, 60_000);

  afterAll(async () => drop?.());

  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    analyzeFile.mockReset();
    suggestFolder.mockReset();
  });

  it("reads the upload, stores the draft and the suggestion, and logs it", async () => {
    const fileId = await upload("sara", "QT-2291.pdf", "quotation one");
    analyzeFile.mockResolvedValue({ status: "analyzed", readStatus: "full", model: "claude-sonnet-5-5", analysis: analysis({ filing: folderFiling(folder["Sales/Quotations"], 0.9, "Quotation we sent") }) });
    const ctx = await ctxFor("sara");

    expect(await intake.readUpload(prisma, ctx, company, fileId)).toEqual({ status: "read" });
    const row = await fileRow(fileId);
    expect(row).toMatchObject({ status: "needs_review", title: "Quotation QT-2291", readStatus: "full", aiModel: "claude-sonnet-5-5", suggestedFolderId: folder["Sales/Quotations"], processingStartedAt: null, summaryConfirmedAt: null });
    // The folders offered are the ones sara may file into: no HR for her.
    const offered = (analyzeFile.mock.calls[0]![2] as { folders: { id: string }[] }).folders.map((f) => f.id);
    expect(offered).toContain(folder["Sales/Quotations"]);
    expect(offered).not.toContain(folder["HR/Personnel"]);
    expect(await prisma.auditLog.findFirst({ where: { action: "file.analyze", targetId: fileId } })).toMatchObject({ userEmail: "sara@api-pharma.net", after: { outcome: "read" } });

    // Reading again does not call the AI again.
    expect(await intake.readUpload(prisma, ctx, company, fileId)).toEqual({ status: "read" });
    expect(analyzeFile).toHaveBeenCalledTimes(1);
    // Still waiting in Review, visible there to sara and admins.
    expect((await files.listUnfiled(prisma, ctx)).map((f) => f.id)).toContain(fileId);
  });

  it("files only after the summary is confirmed; an unchanged summary reuses the suggestion, an edited one asks again", async () => {
    const fileId = await upload("sara", "QT-2292.pdf", "quotation two");
    analyzeFile.mockResolvedValue({ status: "analyzed", readStatus: "full", model: "m", analysis: analysis({ filing: folderFiling(folder["Sales/Quotations"], 0.9, "Quotation we sent") }) });
    const ctx = await ctxFor("sara");
    await intake.readUpload(prisma, ctx, company, fileId);

    await expect(files.moveFile(prisma, ctx, { fileId, folderId: folder.General! })).rejects.toThrow(/Confirm the summary/);

    const draft = intake.summaryToForm(await fileRow(fileId));
    expect(draft).toMatchObject({ title: "Quotation QT-2291", amounts: "1250.5 AED", references: "quotation QT-2291", parties: "API Pharma\nGulf Pharmacy", docDate: "2026-03-15" });
    const unchanged = await intake.confirmSummary(prisma, ctx, company, { fileId, ...draft });
    expect(unchanged.suggestion).toMatchObject({ destination: { kind: "folder", folderId: folder["Sales/Quotations"] }, path: "Sales / Quotations", reason: "Quotation we sent" });
    expect(suggestFolder).not.toHaveBeenCalled();
    expect(await fileRow(fileId)).toMatchObject({ summaryConfirmedBy: "sara@api-pharma.net", status: "needs_review" });
    expect(await prisma.auditLog.findFirst({ where: { action: "file.summary", targetId: fileId } })).toMatchObject({ after: { source: "ai", edited: false } });

    suggestFolder.mockResolvedValue(folderFiling(folder["Purchasing/Supplier Quotations"], 0.7, "A supplier's quotation"));
    const edited = await intake.confirmSummary(prisma, ctx, company, { fileId, ...draft, title: "Supplier quotation from Al Noor" });
    expect(edited.suggestion).toMatchObject({ destination: { kind: "folder", folderId: folder["Purchasing/Supplier Quotations"] }, path: "Purchasing / Supplier Quotations" });
    expect(suggestFolder).toHaveBeenCalledTimes(1);
    // The AI's second look only sees the confirmed summary, never the file.
    expect(JSON.stringify(suggestFolder.mock.calls[0]![2])).toContain("Supplier quotation from Al Noor");
    expect(await prisma.auditLog.count({ where: { action: "file.summary", targetId: fileId, after: { path: ["edited"], equals: true } } })).toBe(1);

    await files.moveFile(prisma, ctx, { fileId, folderId: folder["Purchasing/Supplier Quotations"]! });
    expect(await fileRow(fileId)).toMatchObject({ status: "ready", folderId: folder["Purchasing/Supplier Quotations"], filedBy: "sara@api-pharma.net" });
    expect(await prisma.auditLog.findFirst({ where: { action: "file.move", targetId: fileId } })).toMatchObject({ before: { folderId: null } });
  });

  it("asks for a written summary when the AI cannot read the file, and parses the form", async () => {
    const fileId = await upload("sara", "scan.pdf", "blurry scan");
    analyzeFile.mockResolvedValue({ status: "analyzed", readStatus: "full", model: "m", analysis: analysis({ readable: false, problem: "Handwritten and mostly illegible." }) });
    const ctx = await ctxFor("sara");

    expect(await intake.readUpload(prisma, ctx, company, fileId)).toEqual({ status: "not_read", reason: "Handwritten and mostly illegible.", retryable: false });
    expect(await fileRow(fileId)).toMatchObject({ status: "needs_review", readStatus: "not_read", aiError: "Handwritten and mostly illegible.", title: null });

    await expect(intake.confirmSummary(prisma, ctx, company, { ...intake.summaryToForm(await fileRow(fileId)), fileId, summary: "x", amounts: "lots" })).rejects.toThrow(/Enter amounts/);
    await expect(intake.confirmSummary(prisma, ctx, company, { ...intake.summaryToForm(await fileRow(fileId)), fileId, summary: "" })).rejects.toThrow(UserError);

    suggestFolder.mockResolvedValue(null);
    const result = await intake.confirmSummary(prisma, ctx, company, {
      fileId,
      title: "Delivery note DN-77",
      summary: "Delivery note from Al Noor for 20 cartons, 1,250.50 AED.",
      docType: "",
      docDate: "2026-04-02",
      parties: "Al Noor Chemicals, LLC\nAPI Pharma",
      references: "delivery note DN-77; B2291",
      amounts: "1,250.50 AED; usd 300",
      products: "Metformin 500 mg, 30 tablets\n",
      expiryDate: "",
      tags: "Al Noor, al noor",
    });
    expect(result.suggestion).toBeNull();
    const row = await fileRow(fileId);
    expect(row).toMatchObject({ title: "Delivery note DN-77", docType: null, tags: ["al noor"], summaryConfirmedBy: "sara@api-pharma.net" });
    expect(row.facts).toEqual({
      parties: ["Al Noor Chemicals, LLC", "API Pharma"],
      references: [
        { kind: "delivery", value: "note DN-77" },
        { kind: "reference", value: "B2291" },
      ],
      amounts: [
        { value: 1250.5, currency: "AED" },
        { value: 300, currency: "USD" },
      ],
      products: ["Metformin 500 mg, 30 tablets"],
    });
    expect(await prisma.auditLog.findFirst({ where: { action: "file.summary", targetId: fileId } })).toMatchObject({ after: { source: "manual" } });
    await files.moveFile(prisma, ctx, { fileId, folderId: folder["Logistics/Delivery Notes"]! });
    expect((await fileRow(fileId)).status).toBe("ready");
  });

  it("lets the uploader try again after a failed read or a cap, but not after an unreadable file", async () => {
    const fileId = await upload("sara", "flaky.pdf", "flaky");
    const ctx = await ctxFor("sara");
    analyzeFile.mockRejectedValueOnce(new Error("overloaded"));
    expect(await intake.readUpload(prisma, ctx, company, fileId)).toMatchObject({ status: "not_read", retryable: true, reason: expect.stringContaining("overloaded") });
    expect(await fileRow(fileId)).toMatchObject({ status: "needs_review", readStatus: null });
    expect(await prisma.auditLog.findFirst({ where: { action: "file.analyze", targetId: fileId } })).toMatchObject({ after: { outcome: "failed" } });

    await intake.retryRead(prisma, ctx, fileId);
    expect(await fileRow(fileId)).toMatchObject({ status: "processing", aiError: null });
    analyzeFile.mockResolvedValueOnce({ status: "limit_reached", reason: "You have reached your daily AI limit ($2.00)." });
    expect(await intake.readUpload(prisma, ctx, company, fileId)).toEqual({ status: "not_read", reason: "You have reached your daily AI limit ($2.00).", retryable: true });

    await intake.retryRead(prisma, ctx, fileId);
    analyzeFile.mockResolvedValueOnce({ status: "not_read", reason: "ZIP files are stored but not read" });
    expect(await intake.readUpload(prisma, ctx, company, fileId)).toEqual({ status: "not_read", reason: "ZIP files are stored but not read", retryable: false });
    await expect(intake.retryRead(prisma, ctx, fileId)).rejects.toThrow(/Only a read that failed/);
  });

  it("allows three attempts in all, and never a retry of a file the AI already read", async () => {
    const fileId = await upload("sara", "stubborn.pdf", "stubborn");
    const ctx = await ctxFor("sara");
    for (let attempt = 1; attempt <= intake.MAX_READ_ATTEMPTS; attempt++) {
      analyzeFile.mockRejectedValueOnce(new Error("overloaded"));
      expect(await intake.readUpload(prisma, ctx, company, fileId)).toMatchObject({ status: "not_read", retryable: true });
      if (attempt < intake.MAX_READ_ATTEMPTS) await intake.retryRead(prisma, ctx, fileId);
    }
    await expect(intake.retryRead(prisma, ctx, fileId)).rejects.toThrow(/tried 3 times/);

    const readId = await upload("sara", "fine.pdf", "fine");
    analyzeFile.mockResolvedValueOnce({ status: "analyzed", readStatus: "full", model: "m", analysis: analysis() });
    expect(await intake.readUpload(prisma, ctx, company, readId)).toEqual({ status: "read" });
    await expect(intake.retryRead(prisma, ctx, readId)).rejects.toThrow(/Only a read that failed/);
    expect(analyzeFile).toHaveBeenCalledTimes(intake.MAX_READ_ATTEMPTS + 1);
  });

  it("keeps a file in line, without using an attempt, while another of the person's AI calls runs", async () => {
    const fileId = await upload("admin", "second-of-two.pdf", "second of two");
    const ctx = await ctxFor("admin");
    analyzeFile.mockResolvedValueOnce({ status: "limit_reached", reason: "Wait for your current AI request to finish, then try again.", limit: "user_busy" });
    expect(await intake.readUpload(prisma, ctx, company, fileId)).toEqual({ status: "busy" });
    expect(await fileRow(fileId)).toMatchObject({ status: "processing", processingStartedAt: null, attempts: 0, aiError: null });
    analyzeFile.mockResolvedValueOnce({ status: "analyzed", readStatus: "full", model: "m", analysis: analysis() });
    expect(await intake.readUpload(prisma, ctx, company, fileId)).toEqual({ status: "read" });
  });

  it("does not read a stored object that no longer matches the upload", async () => {
    const fileId = await upload("sara", "swapped.pdf", "original bytes");
    stored.set(`${orgId}/${fileId}/1`, new TextEncoder().encode("something much longer put there later"));
    expect(await intake.readUpload(prisma, await ctxFor("sara"), company, fileId)).toMatchObject({ status: "not_read", retryable: false, reason: expect.stringContaining("not the one that was uploaded") });
    expect(analyzeFile).not.toHaveBeenCalled();
  });

  it("cuts the confirmed facts to the same sizes as the AI's", async () => {
    const fileId = await upload("sara", "facts.pdf", "facts");
    const ctx = await ctxFor("sara");
    analyzeFile.mockRejectedValueOnce(new Error("x"));
    await intake.readUpload(prisma, ctx, company, fileId);
    const parties = Array.from({ length: 40 }, (_, i) => `Party ${i} ${"x".repeat(250)}`).join("\n");
    await intake.confirmSummary(prisma, ctx, company, { ...intake.summaryToForm(await fileRow(fileId)), fileId, summary: "Short.", parties });
    const facts = (await fileRow(fileId)).facts as { parties: string[] };
    expect(facts.parties).toHaveLength(30);
    expect(facts.parties[0]).toHaveLength(200);
    await expect(
      intake.confirmSummary(prisma, ctx, company, { ...intake.summaryToForm(await fileRow(fileId)), fileId, summary: "Short.", parties: "x".repeat(20_001) }),
    ).rejects.toThrow(/too long/);
  });

  it("does not read files over the AI size limit, or when the AI is not set up", async () => {
    vi.stubEnv("FILES_AI_MAX_MB", "1");
    const big = "x".repeat(1024 * 1024 + 1);
    const fileId = await upload("admin", "big.pdf", big);
    expect(await intake.readUpload(prisma, await ctxFor("admin"), company, fileId)).toMatchObject({ status: "not_read", retryable: false, reason: expect.stringContaining("1 MB") });
    vi.stubEnv("FILES_AI_MAX_MB", "");

    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const other = await upload("admin", "no-ai.pdf", "no ai");
    expect(await intake.readUpload(prisma, await ctxFor("admin"), company, other)).toMatchObject({ status: "not_read", reason: expect.stringContaining("not set up") });
    expect(analyzeFile).not.toHaveBeenCalled();
  });

  it("reports busy while another request reads the file, and takes over a dead read", async () => {
    const fileId = await upload("sara", "slow.pdf", "slow");
    const ctx = await ctxFor("sara");
    await prisma.storedFile.update({ where: { id: fileId }, data: { processingStartedAt: new Date() } });
    expect(await intake.readUpload(prisma, ctx, company, fileId)).toEqual({ status: "busy" });

    await prisma.storedFile.update({ where: { id: fileId }, data: { processingStartedAt: new Date(Date.now() - intake.READ_TIMEOUT_MS - 1000) } });
    analyzeFile.mockResolvedValueOnce({ status: "analyzed", readStatus: "full", model: "m", analysis: analysis() });
    expect(await intake.readUpload(prisma, ctx, company, fileId)).toEqual({ status: "read" });
  });

  it("makes everyone but admins wait for the file being read before uploading the next", async () => {
    const fileId = await upload("sara", "first.pdf", "first");
    await prisma.storedFile.update({ where: { id: fileId }, data: { processingStartedAt: new Date() } });
    const sara = await ctxFor("sara");
    await expect(
      files.startUpload(prisma, sara, { name: "second.pdf", size: 6, mimeType: "application/pdf", sha256: sha("second"), allowDuplicate: true }),
    ).rejects.toThrow(/Wait for the file being read/);
    const admin = await ctxFor("admin");
    await expect(
      files.startUpload(prisma, admin, { name: "second.pdf", size: 6, mimeType: "application/pdf", sha256: sha("second"), allowDuplicate: true }),
    ).resolves.toMatchObject({ kind: "upload" });
    // Once the read is over, sara may continue.
    await prisma.storedFile.update({ where: { id: fileId }, data: { status: "needs_review", processingStartedAt: null } });
    await expect(
      files.startUpload(prisma, sara, { name: "third.pdf", size: 5, mimeType: "application/pdf", sha256: sha("third"), allowDuplicate: true }),
    ).resolves.toMatchObject({ kind: "upload" });
  });

  it("keeps other people's waiting files out of reach", async () => {
    const fileId = await upload("admin", "admins.pdf", "admin file");
    const sara = await ctxFor("sara");
    await expect(intake.readUpload(prisma, sara, company, fileId)).rejects.toThrow(UserError);
    await expect(intake.confirmSummary(prisma, sara, company, { ...intake.summaryToForm(await fileRow(fileId)), fileId, summary: "x" })).rejects.toThrow(UserError);
    await expect(intake.retryRead(prisma, sara, fileId)).rejects.toThrow(UserError);
  });
});
