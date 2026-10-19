import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { TEST_DATABASE_URL, freshDatabase } from "@/test/database";
import { addTestFolders } from "@/test/folders";

const stored = new Map<string, Uint8Array>();

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    presignUpload: async (key: string) => `https://bucket.test/put/${key}`,
    head: async (key: string) => (stored.has(key) ? { sizeBytes: stored.get(key)!.length, contentType: null } : null),
    getObject: async (key: string) => stored.get(key) ?? null,
    copy: async (from: string, to: string) => void stored.set(to, stored.get(from)!),
    remove: async (key: string) => void stored.delete(key),
    putObject: async () => undefined,
  };
});

/** Anthropic's batch API, as far as batch reading uses it. */
const remote = {
  created: [] as { requests: { custom_id: string; params: Record<string, unknown> }[] }[],
  status: "in_progress" as "in_progress" | "ended",
  results: [] as unknown[],
};
vi.mock("@/lib/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai")>();
  const batches = {
    create: async (body: (typeof remote.created)[number]) => (remote.created.push(body), { id: `msgbatch_${remote.created.length}` }),
    retrieve: async () => ({ processing_status: remote.status }),
    results: async () =>
      (async function* () {
        yield* remote.results;
      })(),
  };
  return { ...actual, anthropic: () => ({ beta: { messages: { batches } } }) };
});

const { createCompany } = await import("./companies");
const { addMember } = await import("./users");
const files = await import("./files");
const intake = await import("./intake");
const { collectBatches, queueForBatch, submitBatch, batchStatus } = await import("./batch-reading");

const company = { name: "API Pharma", domain: "api-pharma.net", timezone: "Asia/Dubai" };
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const answer = (folderId: string) => ({
  readable: true,
  problem: null,
  title: "Quotation QT-2291",
  summary: "Quotation for insulin glargine to Gulf Pharmacy.",
  docType: "quotation",
  docDate: "2026-03-15",
  language: "en",
  facts: { parties: ["API Pharma"], references: [{ kind: "quotation", value: "QT-2291" }], amounts: [], products: [], items: [], expiryDate: null },
  tags: ["insulin"],
  filing: { placement: "folder", side: null, partyId: null, partyName: null, materialId: null, materialName: null, docKind: null, folderId, confidence: 0.9, reason: "A quotation" },
});

describe.skipIf(!TEST_DATABASE_URL)("batch reading (database)", () => {
  let prisma: PrismaClient;
  let drop: () => Promise<void>;
  let orgId: string;
  let adminId: string;
  const folder: Record<string, string> = {};
  const ctx = () => files.fileContext(prisma, { orgId, userId: adminId, email: "admin@api-pharma.net", role: "admin" });
  const row = (id: string) => prisma.storedFile.findUniqueOrThrow({ where: { id } });

  async function upload(name: string, content: string) {
    const bytes = new TextEncoder().encode(content);
    const started = await files.startUpload(prisma, await ctx(), { name, size: bytes.length, mimeType: "application/pdf", sha256: sha(bytes), allowDuplicate: true });
    if (started.kind !== "upload") throw new Error("expected an upload");
    stored.set(`${orgId}/${started.fileId}/1.upload`, bytes);
    await files.confirmUpload(prisma, await ctx(), { fileId: started.fileId, versionNo: 1 });
    return started.fileId;
  }

  beforeAll(async () => {
    ({ prisma, drop } = await freshDatabase());
    orgId = (await createCompany(prisma, { slug: "api-pharma", name: company.name, domain: company.domain, actorEmail: "t" })).id;
    await addTestFolders(prisma, orgId);
    ({ userId: adminId } = await addMember(prisma, { orgId, email: "admin@api-pharma.net", role: "admin", actor: { email: "t" } }));
    for (const f of await prisma.folder.findMany({ where: { orgId }, include: { parent: true } })) folder[f.parent ? `${f.parent.name}/${f.name}` : f.name] = f.id;
  }, 60_000);

  afterAll(async () => drop?.());

  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.stubEnv("FILES_AI_MAX_MB", "1");
  });

  it("sends waiting files in one batch with the live-read request, and settles files the AI never reads", async () => {
    const quote = await upload("quote.pdf", "%PDF-1.7 quotation");
    const damaged = await upload("damaged.pdf", "%PDF-1.7 broken");
    const big = await upload("big.pdf", `%PDF-1.7 ${"x".repeat(1_100_000)}`);
    for (const id of [quote, damaged, big]) await queueForBatch(prisma, await ctx(), id);
    expect(await batchStatus(prisma, orgId)).toEqual({ waiting: 3, reading: 0, batches: 0 });
    // A queued file is left to the batch, not read now.
    expect(await intake.readUpload(prisma, await ctx(), company, quote)).toEqual({ status: "busy" });

    expect(await submitBatch(prisma, await ctx(), company)).toEqual({ sent: 2, notRead: 1, waiting: 0 });
    const [sent] = remote.created;
    expect(sent!.requests.map((r) => r.custom_id).sort()).toEqual([damaged, quote].sort());
    const params = sent!.requests[0]!.params;
    expect(params).toMatchObject({ model: "claude-sonnet-5-5", tool_choice: { type: "auto" } });
    expect(params).not.toHaveProperty("fallbacks");

    expect(await row(big)).toMatchObject({ status: "needs_review", readStatus: "not_read", batchQueuedAt: null, aiError: expect.stringContaining("larger than 1 MB") });
    expect(await row(quote)).toMatchObject({ status: "processing", aiBatchId: expect.any(String) });
    expect(await prisma.aiBatch.findFirstOrThrow({ where: { orgId } })).toMatchObject({ anthropicId: "msgbatch_1", status: "in_progress", fileCount: 2 });
    expect(await batchStatus(prisma, orgId)).toEqual({ waiting: 0, reading: 2, batches: 1 });
  });

  it("only checks a batch that is still running, then stores and files its results at half price", async () => {
    expect(await collectBatches(prisma, { orgId })).toMatchObject({ checked: 1, finished: 0 });

    const idOf = async (name: string) => (await prisma.storedFile.findFirstOrThrow({ where: { orgId, name } })).id;
    const [quote, damaged] = [await idOf("quote.pdf"), await idOf("damaged.pdf")];
    remote.status = "ended";
    remote.results = [
      {
        custom_id: quote,
        result: {
          type: "succeeded",
          message: {
            model: "claude-sonnet-5-5",
            stop_reason: "tool_use",
            content: [{ type: "tool_use", id: "t1", name: "record_analysis", input: answer(folder["Sales/Quotations"]!) }],
            usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        },
      },
      { custom_id: damaged, result: { type: "errored", error: { type: "error", error: { type: "invalid_request_error", message: "The PDF is damaged" } } } },
    ];

    expect(await collectBatches(prisma, { orgId })).toEqual({ checked: 1, finished: 1, read: 1, filed: 1, review: 1 });
    expect(await row(quote)).toMatchObject({ status: "ready", folderId: folder["Sales/Quotations"], title: "Quotation QT-2291", batchQueuedAt: null });
    expect(await row(damaged)).toMatchObject({ status: "needs_review", readStatus: "not_read", aiError: "Claude could not read this file: The PDF is damaged" });
    // A million input tokens on Sonnet 5.5 is $2; in a batch, $1.
    expect((await prisma.aiUsage.findFirstOrThrow({ where: { fileId: quote } })).costUsd).toBeCloseTo(1, 5);
    expect(await prisma.aiBatch.findFirstOrThrow({ where: { orgId } })).toMatchObject({ status: "ended" });

    // Nothing is stored twice.
    expect(await collectBatches(prisma, { orgId })).toMatchObject({ checked: 0, finished: 0 });
    expect(await prisma.aiUsage.count({ where: { fileId: quote } })).toBe(1);
  });

  it("puts files from a send that was cut off back in line", async () => {
    const id = await upload("late.pdf", "%PDF-1.7 late");
    await queueForBatch(prisma, await ctx(), id);
    const cut = await prisma.aiBatch.create({ data: { orgId, model: "claude-sonnet-5-5", createdBy: adminId, createdAt: new Date(Date.now() - 60 * 60 * 1000) } });
    await prisma.storedFile.update({ where: { id }, data: { aiBatchId: cut.id } });

    await collectBatches(prisma, { orgId });
    expect(await row(id)).toMatchObject({ status: "processing", aiBatchId: null });
    expect(await prisma.aiBatch.findUniqueOrThrow({ where: { id: cut.id } })).toMatchObject({ status: "failed" });
    expect((await batchStatus(prisma, orgId)).waiting).toBe(1);
  });
});
