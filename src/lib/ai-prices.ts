/** USD per million tokens; cache writes at the 5-minute rate. */
export type Price = { input: number; cacheWrite: number; cacheRead: number; output: number };

/**
 * From https://platform.claude.com/docs/en/about-claude/pricing, checked 2026-10-12.
 * Claude Haiku 5.5 is priced higher when the prompt is over 100,000 tokens.
 * Kept apart from ai.ts so env.ts can check the configured model ids without a circular import.
 */
export const PRICES: Record<string, (promptTokens: number) => Price> = {
  "claude-opus-5-5": () => ({ input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 }),
  "claude-sonnet-5-5": () => ({ input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 }),
  "claude-sonnet-5": () => ({ input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 }),
  "claude-haiku-5-5": (prompt) =>
    prompt > 100_000
      ? { input: 0.5, cacheWrite: 0.625, cacheRead: 0.05, output: 2.5 }
      : { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 },
  "claude-haiku-4-5": () => ({ input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }),
};

/** The dearest priced model; a model missing from the table is charged at this rate rather than $0. */
export const FALLBACK_PRICE_MODEL = "claude-opus-5-5";

export const KNOWN_MODELS = Object.keys(PRICES);
