import Anthropic from "@anthropic-ai/sdk";
import type { AiPurpose } from "@/generated/prisma/enums";
import { checkBudget, type LimitReason } from "@/lib/ai-limits";
import type { Db } from "@/lib/db";
import { aiEnv } from "@/lib/env";
import { startOfDay } from "@/lib/time";

type MessageParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.Messages.BetaMessage;

/** USD per million tokens; cache writes at the 5-minute rate. */
type Price = { input: number; cacheWrite: number; cacheRead: number; output: number };

/**
 * From https://platform.claude.com/docs/en/about-claude/pricing, checked 2026-10-11.
 * Claude Haiku 5.5 is priced higher when the prompt is over 100,000 tokens.
 */
const PRICES: Record<string, (promptTokens: number) => Price> = {
  "claude-opus-5-5": () => ({ input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 }),
  "claude-sonnet-5-5": () => ({ input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 }),
  "claude-sonnet-5": () => ({ input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 }),
  "claude-haiku-5-5": (prompt) =>
    prompt > 100_000
      ? { input: 0.5, cacheWrite: 0.625, cacheRead: 0.05, output: 2.5 }
      : { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 },
  "claude-haiku-4-5": () => ({ input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }),
};

/** Models that accept `fallbacks: "default"`, which retries some safety declines on another model. */
const SERVER_FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** Cost in USD, or null for a model missing from the price table. */
export function costUsd(model: string, tokens: Tokens): number | null {
  const price = PRICES[model];
  if (!price) return null;
  const p = price(tokens.input + tokens.cacheRead + tokens.cacheWrite);
  return (
    (tokens.input * p.input + tokens.cacheWrite * p.cacheWrite + tokens.cacheRead * p.cacheRead + tokens.output * p.output) /
    1_000_000
  );
}

/**
 * Sums token counts and cost over every model that worked on the response: the requested model,
 * then any fallback model that took over after a decline.
 */
export function usageOf(
  message: Pick<Message, "model" | "usage">,
  requestedModel: string,
): Tokens & { costUsd: number | null } {
  const runs = (message.usage.iterations ?? []).flatMap((it) =>
    it.type === "message" || it.type === "fallback_message"
      ? [
          {
            model: it.type === "fallback_message" ? it.model : requestedModel,
            input: it.input_tokens,
            output: it.output_tokens,
            cacheRead: it.cache_read_input_tokens ?? 0,
            cacheWrite: it.cache_creation_input_tokens ?? 0,
          },
        ]
      : [],
  );
  if (runs.length === 0) {
    runs.push({
      model: message.model,
      input: message.usage.input_tokens,
      output: message.usage.output_tokens,
      cacheRead: message.usage.cache_read_input_tokens ?? 0,
      cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
    });
  }
  let cost: number | null = 0;
  const total: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const run of runs) {
    total.input += run.input;
    total.output += run.output;
    total.cacheRead += run.cacheRead;
    total.cacheWrite += run.cacheWrite;
    const runCost = costUsd(run.model, run);
    cost = cost === null || runCost === null ? null : cost + runCost;
  }
  return { ...total, costUsd: cost };
}

/** A cap stopped the call. The message is written for the person who hit it. */
export class AiLimitError extends Error {
  constructor(
    public readonly reason: LimitReason,
    message: string,
  ) {
    super(message);
    this.name = "AiLimitError";
  }
}

let client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!client) {
    // Bounded so a slow call cannot outlive the reading route; the uploader can retry by hand.
    client = new Anthropic({ apiKey: aiEnv().ANTHROPIC_API_KEY, timeout: 90_000, maxRetries: 0 });
  }
  return client;
}

export type AiCallContext = {
  orgId: string;
  timezone: string;
  purpose: AiPurpose;
  userId?: string | null;
  fileId?: string | null;
};

/**
 * Reserves one call against the company's daily call cap and the dollar caps, and records it.
 * An advisory lock per company makes the checks and the insert atomic. Throws AiLimitError.
 */
async function reserveCall(prisma: Db, ctx: AiCallContext, model: string, cap: number): Promise<string> {
  const now = new Date();
  const since = startOfDay(now, ctx.timezone);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ai-cap:${ctx.orgId}`}))`;
    const used = await tx.aiUsage.count({ where: { orgId: ctx.orgId, createdAt: { gte: since } } });
    if (used >= cap) throw new AiLimitError("company_calls", `The company has reached its daily limit of ${cap} AI calls.`);
    const budget = await checkBudget(tx, ctx, now);
    if (!budget.ok) throw new AiLimitError(budget.reason, budget.message);
    const row = await tx.aiUsage.create({
      data: { orgId: ctx.orgId, userId: ctx.userId ?? null, fileId: ctx.fileId ?? null, purpose: ctx.purpose, model },
      select: { id: true },
    });
    return row.id;
  });
}

/**
 * Every Claude call goes through here: it enforces the call and dollar caps, opts into server-side
 * refusal fallbacks where the model supports them, and writes an AiUsage row with tokens and cost.
 * Throws AiLimitError when a cap is reached; API errors are recorded, then rethrown.
 */
export async function callClaude(
  prisma: Db,
  ctx: AiCallContext,
  params: MessageParams,
  client: Pick<Anthropic, "beta"> = anthropic(),
): Promise<Message> {
  const usageId = await reserveCall(prisma, ctx, params.model, aiEnv().AI_MAX_CALLS_PER_DAY);

  try {
    const message = await client.beta.messages.create(
      SERVER_FALLBACK_MODELS.has(params.model)
        ? { ...params, betas: [...(params.betas ?? []), "server-side-fallback-2026-07-01"], fallbacks: "default" }
        : params,
    );
    const usage = usageOf(message, params.model);
    if (usage.costUsd === null) console.warn(`[ai] no price for model ${message.model}; cost recorded as 0`);
    await prisma.aiUsage.update({
      where: { id: usageId },
      data: {
        model: message.model,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        costUsd: usage.costUsd ?? 0,
        error:
          message.stop_reason === "refusal"
            ? `refused${message.stop_details?.category ? ` (${message.stop_details.category})` : ""}`
            : null,
      },
    });
    return message;
  } catch (error) {
    await prisma.aiUsage.update({
      where: { id: usageId },
      data: { error: (error instanceof Error ? error.message : String(error)).slice(0, 500) },
    });
    throw error;
  }
}
