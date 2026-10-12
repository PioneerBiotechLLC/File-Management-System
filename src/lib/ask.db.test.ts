import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { TEST_DATABASE_URL, freshDatabase } from "@/test/database";

const callClaude = vi.fn();

vi.mock("@/lib/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai")>();
  return { ...actual, callClaude: (...args: unknown[]) => callClaude(...args) };
});

const { ask } = await import("./ask");
const { AiLimitError } = await import("@/lib/ai");
const { createCompany } = await import("./companies");
const { UserError } = await import("./errors");
const { fileContext } = await import("./files");
const { reindexFile } = await import("./search-index");
const { addMember } = await import("./users");

const company = { name: "API Pharma", timezone: "Asia/Dubai" };
const usage = { input_tokens: 1_200, output_tokens: 150, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, iterations: null };

function toolUse(name: string, input: unknown, id = "toolu_1") {
  return { model: "claude-haiku-5-5", stop_reason: "tool_use", stop_details: null, usage, content: [{ type: "tool_use", id, name, input }] };
}

describe.skipIf(!TEST_DATABASE_URL)("ask: AI search (database)", () => {
  let prisma: PrismaClient;
  let drop: () => Promise<void>;
  let orgId: string;
  let saraId: string;
  let vicId: string;
  let quoteId: string;
  let salaryId: string;

  const sara = () => fileContext(prisma, { orgId, userId: saraId, email: "sara@api-pharma.net", role: "editor" });

  beforeAll(async () => {
    ({ prisma, drop } = await freshDatabase());
    orgId = (await createCompany(prisma, { slug: "api-pharma", name: company.name, domain: "api-pharma.net", actorEmail: "t" })).id;
    ({ userId: saraId } = await addMember(prisma, { orgId, email: "sara@api-pharma.net", role: "editor", actor: { email: "t" } }));
    ({ userId: vicId } = await addMember(prisma, { orgId, email: "vic@api-pharma.net", role: "viewer", actor: { email: "t" } }));
    const folders = await prisma.folder.findMany({ where: { orgId }, include: { parent: true } });
    const folder = (p: string) => folders.find((f) => (f.parent ? `${f.parent.name}/${f.name}` : f.name) === p)!.id;
    const make = async (data: { name: string; folderId: string; summary: string; facts?: object; uploadedBy?: string }) => {
      const row = await prisma.storedFile.create({
        data: { orgId, name: data.name, originalName: data.name, mimeType: "application/pdf", sizeBytes: 1, sha256: data.name.padEnd(64, "0"), status: "ready", uploadedBy: data.uploadedBy ?? saraId, folderId: data.folderId, summary: data.summary, facts: data.facts ?? {} },
      });
      await reindexFile(prisma, row.id);
      return row.id;
    };
    quoteId = await make({ name: "QT-2291.pdf", folderId: folder("Sales/Quotations"), summary: "Quotation to Gulf Pharmacy for insulin, 41,500 AED.", facts: { amounts: [{ value: 41500, currency: "AED" }], parties: ["Gulf Pharmacy"] } });
    salaryId = await make({ name: "salaries.pdf", folderId: folder("HR/Personnel"), summary: "Salary review, insulin team.", uploadedBy: vicId });
  }, 60_000);

  afterAll(async () => drop?.());

  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    callClaude.mockReset();
    await prisma.auditLog.deleteMany({ where: { action: "search.ask" } });
  });

  it("searches with the ranges the model derives, answers only with files it was shown, and logs", async () => {
    callClaude
      .mockResolvedValueOnce(toolUse("search_files", { query: "insulin gulf", amountMin: 32000, amountMax: 48000, currency: "AED" }))
      .mockResolvedValueOnce(toolUse("get_files", { ids: [quoteId, salaryId] }, "toolu_2"))
      .mockResolvedValueOnce(
        toolUse("answer", { text: "Found the Gulf Pharmacy quotation.", files: [{ id: quoteId, why: "Insulin quotation for 41,500 AED" }, { id: salaryId, why: "Mentions insulin" }, { id: "made-up", why: "x" }] }, "toolu_3"),
      );

    const result = await ask(prisma, await sara(), company, "the insulin quotation we sent Gulf Pharmacy, around 40k AED");

    expect(result.text).toBe("Found the Gulf Pharmacy quotation.");
    // The restricted HR file never reached the model, so it cannot be cited; nor can an invented id.
    expect(result.files.map((f) => f.id)).toEqual([quoteId]);
    expect(result.files[0]).toMatchObject({ why: "Insulin quotation for 41,500 AED", folderPath: "Sales / Quotations" });
    expect(result.calls).toBe(2);

    // What the tools gave the model: the quotation, never the HR file (even when asked for by id).
    const toolResults = (round: number) => {
      const { messages } = callClaude.mock.calls[round]![2] as { messages: { role: string; content: unknown }[] };
      return JSON.stringify(messages.filter((m) => m.role === "user").map((m) => m.content));
    };
    expect(toolResults(1)).toContain(quoteId);
    expect(toolResults(1)).not.toContain(salaryId);
    expect(toolResults(2)).toContain("41,500 AED");
    expect(toolResults(2)).not.toContain("Salary review");
    // The system prompt carries today's date and the visible folders, cached.
    const first = callClaude.mock.calls[0]![2] as { system: { text: string; cache_control?: unknown }[]; tool_choice: unknown };
    expect(first.system[1]!.text).toMatch(/Today is \d{4}-\d{2}-\d{2}/);
    expect(first.system[1]!.text).toContain("Sales / Quotations");
    expect(first.system[1]!.text).not.toContain("HR / Personnel");
    expect(first.system[1]!.cache_control).toEqual({ type: "ephemeral" });
    expect(first.tool_choice).toEqual({ type: "any" });

    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "search.ask" } });
    expect(log).toMatchObject({ userEmail: "sara@api-pharma.net", after: { question: expect.stringContaining("Gulf Pharmacy"), files: [quoteId], calls: 2 } });
  });

  it("forces an answer after four tool calls", async () => {
    for (let i = 0; i < 4; i++) callClaude.mockResolvedValueOnce(toolUse("search_files", { query: `try ${i}` }, `toolu_${i}`));
    callClaude.mockResolvedValueOnce(toolUse("answer", { text: "Nothing matched.", files: [] }, "toolu_final"));
    const result = await ask(prisma, await sara(), company, "something obscure");
    expect(result).toMatchObject({ text: "Nothing matched.", files: [], calls: 4 });
    const last = callClaude.mock.calls[4]![2] as { tool_choice: unknown; tools: { name: string }[] };
    expect(last.tool_choice).toEqual({ type: "tool", name: "answer" });
    expect(last.tools.map((t) => t.name)).toEqual(["answer"]);
  });

  it("treats plain text as the answer", async () => {
    callClaude.mockResolvedValueOnce({ ...toolUse("x", {}), content: [{ type: "text", text: "Try a product name." }], stop_reason: "end_turn" });
    expect(await ask(prisma, await sara(), company, "?")).toMatchObject({ text: "Try a product name.", files: [], calls: 0 });
  });

  it("stops at the daily number of AI searches, and explains caps and failures", async () => {
    vi.stubEnv("FILES_AI_SEARCHES_PER_USER_PER_DAY", "1");
    callClaude.mockResolvedValueOnce(toolUse("answer", { text: "ok", files: [] }));
    await ask(prisma, await sara(), company, "first");
    await expect(ask(prisma, await sara(), company, "second")).rejects.toThrow(/today's 1 AI searches/);
    vi.stubEnv("FILES_AI_SEARCHES_PER_USER_PER_DAY", "10");

    callClaude.mockRejectedValueOnce(new AiLimitError("user_day", "You have reached your daily AI limit ($2.00)."));
    await expect(ask(prisma, await sara(), company, "third")).rejects.toThrow(/daily AI limit.*Instant search still works/);
    expect(await prisma.auditLog.findFirst({ where: { action: "search.ask", after: { path: ["question"], equals: "third" } } })).toMatchObject({ after: { error: expect.stringContaining("daily AI limit") } });

    callClaude.mockRejectedValueOnce(new Error("overloaded"));
    await expect(ask(prisma, await sara(), company, "fourth")).rejects.toThrow("overloaded");

    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(ask(prisma, await sara(), company, "fifth")).rejects.toThrow(UserError);
  });
});
