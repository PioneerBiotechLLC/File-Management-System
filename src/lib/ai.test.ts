import { describe, expect, it } from "vitest";
import { costUsd, usageOf } from "./ai";

const tokens = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });

describe("costUsd", () => {
  it("prices Claude Sonnet 5.5", () => {
    // 10k input at $2, 1k output at $10, 2k cache read at $0.10, 1k cache write at $2.50 per million.
    expect(costUsd("claude-sonnet-5-5", tokens(10_000, 1_000, 2_000, 1_000))).toBeCloseTo(0.02 + 0.01 + 0.0002 + 0.0025, 10);
  });

  it("switches Claude Haiku 5.5 to long-prompt prices above 100,000 prompt tokens", () => {
    expect(costUsd("claude-haiku-5-5", tokens(100_000, 1_000))).toBeCloseTo(0.01 + 0.0005, 10);
    expect(costUsd("claude-haiku-5-5", tokens(90_000, 1_000, 20_000))).toBeCloseTo(0.045 + 0.0025 + 0.001, 10);
  });

  it("charges an unknown model at the dearest known rate rather than nothing", () => {
    expect(costUsd("claude-unknown", tokens(1_000, 100))).toBeCloseTo((1_000 * 4 + 100 * 20) / 1e6, 12);
  });
});

const baseUsage = {
  cache_creation: null,
  cache_creation_input_tokens: 100,
  cache_read_input_tokens: 200,
  fallback_credit: null,
  inference_geo: null,
  input_tokens: 1_000,
  iterations: null,
  output_tokens: 500,
  output_tokens_details: null,
  model: "claude-sonnet-5-5",
  server_tool_use: null,
  service_tier: null,
  speed: null,
} as const;

describe("usageOf", () => {
  it("reads top-level usage when there are no iterations", () => {
    const u = usageOf({ model: "claude-sonnet-5-5", usage: baseUsage }, "claude-sonnet-5-5");
    expect(u).toMatchObject({ input: 1_000, output: 500, cacheRead: 200, cacheWrite: 100, unpriced: [] });
    expect(u.costUsd).toBeCloseTo((1_000 * 2 + 500 * 10 + 200 * 0.1 + 100 * 2.5) / 1e6, 12);
  });

  it("names a model it had to price at the fallback rate", () => {
    const u = usageOf({ model: "claude-mystery", usage: baseUsage }, "claude-sonnet-5-5");
    expect(u.unpriced).toEqual(["claude-mystery"]);
    expect(u.costUsd).toBeCloseTo((1_000 * 4 + 500 * 20 + 200 * 0.2 + 100 * 5) / 1e6, 12);
  });

  it("prices each model in a fallback chain separately", () => {
    const u = usageOf({
      model: "claude-sonnet-5",
      usage: {
        ...baseUsage,
        iterations: [
          { type: "message", input_tokens: 1_000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
          {
            type: "fallback_message",
            model: "claude-sonnet-5",
            input_tokens: 1_000,
            output_tokens: 400,
            cache_read_input_tokens: 500,
            cache_creation_input_tokens: 0,
            cache_creation: null,
          },
        ],
      },
    } as unknown as Parameters<typeof usageOf>[0], "claude-opus-5-5");
    expect(u).toMatchObject({ input: 2_000, output: 410, cacheRead: 500 });
    // The declined first run is priced as Claude Opus 5.5, the rescue as Claude Sonnet 5.
    expect(u.costUsd).toBeCloseTo((1_000 * 4 + 10 * 20) / 1e6 + (1_000 * 2 + 400 * 10 + 500 * 0.2) / 1e6, 12);
  });
});
