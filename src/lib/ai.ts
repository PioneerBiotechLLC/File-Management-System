import Anthropic from "@anthropic-ai/sdk";
import type { AiPurpose } from "@/generated/prisma/enums";
import { checkBudget, type LimitReason, countedUsage, exemptUserIds } from "@/lib/ai-limits";
import { FALLBACK_PRICE_MODEL, PRICES } from "@/lib/ai-prices";
import type { Db } from "@/lib/db";
import { aiEnv } from "@/lib/env";
import { startOfDay } from "@/lib/time";

type MessageParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.Messages.BetaMessage;

/**
 * Set aside against the dollar caps the moment a call starts, until its real cost replaces it.
 * A file read is at most ~200k input tokens on Claude Sonnet 5.5; a search round is tiny.
 */
export const RESERVE_USD: Record<AiPurpose, number> = { file_analysis: 0.5, file_search: 0.02 };

/** A call with no result after this long no longer counts as in flight. */
const IN_FLIGHT_MS = 3 * 60 * 1000;

/** Models that accept `fallbacks: "default"`, which retries some safety declines on another model. */
const SERVER_FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

export const isPriced = (model: string): boolean => model in PRICES;

/** Cost in USD. A model missing from the price table is charged at the dearest known rate, never at $0. */
export function costUsd(model: string, tokens: Tokens): number {
  const price = PRICES[model] ?? PRICES[FALLBACK_PRICE_MODEL]!;
  const p = price(tokens.input + tokens.cacheRead + tokens.cacheWrite);
  return (
    (tokens.input * p.input + tokens.cacheWrite * p.cacheWrite + tokens.cacheRead * p.cacheRead + tokens.output * p.output) /
    1_000_000
  );
}

/**
 * Sums token counts and cost over every model that worked on the response: the requested model,
 * then any fallback model that took over after a decline. `unpriced` names models charged at
 * the fallback rate because they are missing from the table.
 */
export function usageOf(message: Pick<Message, "model" | "usage">, requestedModel: string): Tokens & { costUsd: number; unpriced: string[] } {
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
  let cost = 0;
  const unpriced: string[] = [];
  const total: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const run of runs) {
    total.input += run.input;
    total.output += run.output;
    total.cacheRead += run.cacheRead;
    total.cacheWrite += run.cacheWrite;
    cost += costUsd(run.model, run);
    if (!isPriced(run.model) && !unpriced.includes(run.model)) unpriced.push(run.model);
  }
  return { ...total, costUsd: cost, unpriced };
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
    client = new Anthropic({ apiKey: aiEnv().ANTHROPIC_API_KEY, timeout: 90_000, maxRetries: 2 });
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
 * Reserves one call against the company's daily call cap and the dollar caps, and records it
 * with an estimated cost so that calls still running count. One call at a time per person. An
 * advisory lock per company makes the checks and the insert atomic. Throws AiLimitError.
 */
async function reserveCall(prisma: Db, ctx: AiCallContext, model: string, cap: number): Promise<string> {
  if (cap <= 0) throw new AiLimitError("company_calls", "The AI is switched off on this server.");
  // Fail closed: a model that cannot be priced cannot be charged against the caps.
  if (!isPriced(model)) throw new Error(`No price is known for model ${model}; add it to ai-prices.ts`);
  const now = new Date();
  const since = startOfDay(now, ctx.timezone);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ai-cap:${ctx.orgId}`}))`;
    // Admins and owners have no cap at all, only one call at a time; nor do they count for others.
    const exempt = await exemptUserIds(tx, ctx.orgId);
    if (!(ctx.userId && exempt.includes(ctx.userId))) {
      const used = await tx.aiUsage.count({ where: { ...countedUsage(ctx.orgId, exempt), createdAt: { gte: since } } });
      if (used >= cap) throw new AiLimitError("company_calls", `The company has reached its daily limit of ${cap} AI calls.`);
    }
    if (ctx.userId) {
      const inFlight = await tx.aiUsage.count({
        where: { orgId: ctx.orgId, userId: ctx.userId, finishedAt: null, createdAt: { gte: new Date(now.getTime() - IN_FLIGHT_MS) } },
      });
      if (inFlight > 0) throw new AiLimitError("user_busy", "Wait for your current AI request to finish, then try again.");
    }
    const budget = await checkBudget(tx, ctx, now);
    if (!budget.ok) throw new AiLimitError(budget.reason, budget.message);
    const row = await tx.aiUsage.create({
      data: { orgId: ctx.orgId, userId: ctx.userId ?? null, fileId: ctx.fileId ?? null, purpose: ctx.purpose, model, costUsd: RESERVE_USD[ctx.purpose] },
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
    if (usage.unpriced.length) console.warn(`[ai] no price for ${usage.unpriced.join(", ")}; charged at the ${FALLBACK_PRICE_MODEL} rate`);
    await prisma.aiUsage.update({
      where: { id: usageId },
      data: {
        model: message.model,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        costUsd: usage.costUsd,
        finishedAt: new Date(),
        error:
          message.stop_reason === "refusal"
            ? `refused${message.stop_details?.category ? ` (${message.stop_details.category})` : ""}`
            : usage.unpriced.length
              ? `unpriced model ${usage.unpriced.join(", ")}`
              : null,
      },
    });
    return message;
  } catch (error) {
    // A timeout may still have been billed, so its reservation stands; other failures cost nothing.
    const timedOut = error instanceof Anthropic.APIConnectionTimeoutError;
    await prisma.aiUsage.update({
      where: { id: usageId },
      data: { error: (error instanceof Error ? error.message : String(error)).slice(0, 500), finishedAt: new Date(), ...(timedOut ? {} : { costUsd: 0 }) },
    });
    throw error;
  }
}
