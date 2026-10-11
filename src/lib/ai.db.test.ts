import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { TEST_DATABASE_URL, freshDatabase, migrationNames } from "@/test/database";
import { AiLimitError, callClaude } from "./ai";

function fakeClient(create: (...args: unknown[]) => Promise<unknown>) {
  return { beta: { messages: { create } } } as unknown as Pick<Anthropic, "beta">;
}

const reply = {
  model: "claude-sonnet-5-5",
  stop_reason: "end_turn",
  stop_details: null,
  content: [{ type: "text", text: "ok" }],
  usage: { input_tokens: 1_000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 0, iterations: null },
};

const params = { model: "claude-sonnet-5-5", max_tokens: 100, messages: [{ role: "user" as const, content: "hi" }] };

describe.skipIf(!TEST_DATABASE_URL)("callClaude and the daily cap (database)", () => {
  let prisma: PrismaClient;
  let drop: () => Promise<void>;
  let orgId: string;
  const ctx = () => ({ orgId, timezone: "Asia/Dubai", purpose: "file_analysis" as const, fileId: "file1" });

  beforeAll(async () => {
    ({ prisma, drop } = await freshDatabase());
    orgId = (await prisma.organization.create({ data: { slug: "cap", name: "Cap", domain: "cap.example" } })).id;
  }, 60_000);

  afterAll(async () => drop?.());

  beforeEach(async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.stubEnv("AI_MAX_CALLS_PER_DAY", "3");
    await prisma.aiUsage.deleteMany();
  });

  it("applies every migration on an empty database", () => {
    expect(migrationNames().length).toBeGreaterThan(0);
  });

  it("records tokens and cost for each call, with fallbacks requested for Claude Sonnet 5.5", async () => {
    const create = vi.fn().mockResolvedValue(reply);
    await callClaude(prisma, ctx(), params, fakeClient(create));

    expect(create.mock.calls[0]![0]).toMatchObject({ fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
    const row = await prisma.aiUsage.findFirstOrThrow({ where: { orgId } });
    expect(row).toMatchObject({ fileId: "file1", purpose: "file_analysis", inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 500, error: null });
    expect(row.costUsd).toBeCloseTo((1_000 * 2 + 200 * 10 + 500 * 0.1) / 1e6, 10);
  });

  it("does not request fallbacks for models without them", async () => {
    const create = vi.fn().mockResolvedValue({ ...reply, model: "claude-haiku-5-5" });
    await callClaude(prisma, ctx(), { ...params, model: "claude-haiku-5-5" }, fakeClient(create));
    expect(create.mock.calls[0]![0]).not.toHaveProperty("fallbacks");
  });

  it("stops at the daily cap, even under concurrency, and ignores yesterday", async () => {
    await prisma.aiUsage.create({
      data: { orgId, purpose: "file_analysis", model: "m", createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) },
    });
    const create = vi.fn().mockResolvedValue(reply);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => callClaude(prisma, ctx(), params, fakeClient(create))));

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((r) => r.status === "rejected" && r.reason instanceof AiLimitError)).toHaveLength(3);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("records failed calls with their error, and they count toward the cap", async () => {
    const create = vi.fn().mockRejectedValue(new Error("overloaded"));
    await expect(callClaude(prisma, ctx(), params, fakeClient(create))).rejects.toThrow("overloaded");
    expect(await prisma.aiUsage.findFirstOrThrow({ where: { orgId } })).toMatchObject({ error: "overloaded", inputTokens: 0 });
  });

  it("records refusals", async () => {
    const create = vi.fn().mockResolvedValue({ ...reply, stop_reason: "refusal", stop_details: { category: "bio" } });
    await callClaude(prisma, ctx(), params, fakeClient(create));
    expect((await prisma.aiUsage.findFirstOrThrow({ where: { orgId } })).error).toBe("refused (bio)");
  });
});
