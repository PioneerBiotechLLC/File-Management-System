import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvError, aiEnv, environmentProblems, limitsEnv, storageEnv } from "./env";

afterEach(() => vi.unstubAllEnvs());

describe("environment", () => {
  it("names each missing variable plainly", () => {
    vi.stubEnv("FILES_S3_BUCKET", "");
    vi.stubEnv("FILES_S3_ENDPOINT", "not a url");
    const problems = environmentProblems();
    expect(problems).toContain("FILES_S3_BUCKET is missing");
    expect(problems).toContain("FILES_S3_ENDPOINT must be a URL");
    expect(() => storageEnv()).toThrow(EnvError);
  });

  it("applies defaults for optional settings", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    vi.stubEnv("ANTHROPIC_MODEL", "");
    expect(aiEnv()).toMatchObject({ ANTHROPIC_MODEL: "claude-sonnet-5-5", ANTHROPIC_MODEL_LIGHT: "claude-haiku-5-5", AI_MAX_CALLS_PER_DAY: 500 });
    expect(limitsEnv()).toMatchObject({
      FILES_MAX_MB: 100,
      FILES_AI_MAX_MB: 22,
      FILES_AI_SEARCHES_PER_USER_PER_DAY: 50,
      AI_DAILY_USD: 10,
      AI_MONTHLY_USD: 150,
      AI_USER_DAILY_USD: 2,
      AI_USER_MONTHLY_USD: 30,
    });
  });

  it("rejects an encryption key that is not 32 bytes", () => {
    vi.stubEnv("DATA_ENCRYPTION_KEY", Buffer.alloc(16).toString("base64"));
    expect(() => limitsEnv()).toThrow(/32 bytes/);
    vi.stubEnv("DATA_ENCRYPTION_KEY", Buffer.alloc(32).toString("base64"));
    expect(limitsEnv().DATA_ENCRYPTION_KEY).toBeDefined();
  });

  it("rejects a negative spend cap", () => {
    vi.stubEnv("AI_DAILY_USD", "-1");
    expect(() => limitsEnv()).toThrow(EnvError);
  });
});
