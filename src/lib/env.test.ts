import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvError, aiEnv, allowedTenantIds, authEnv, environmentProblems, limitsEnv, storageEnv, tenantOfIssuer } from "./env";

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

  it("refuses a model that has no price, so nothing can run uncharged", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    vi.stubEnv("ANTHROPIC_MODEL", "claude-sonnet-5-5-20260101");
    expect(() => aiEnv()).toThrow(/must be one of/);
  });

  it("allows switching the AI off with a call cap of 0", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    vi.stubEnv("AI_MAX_CALLS_PER_DAY", "0");
    expect(aiEnv().AI_MAX_CALLS_PER_DAY).toBe(0);
  });

  describe("sign-in tenants", () => {
    const TENANT = "f88cf322-32f1-4974-9c41-fce70d003de2";
    const stubAuth = (issuer: string, tenants?: string) => {
      vi.stubEnv("AUTH_SECRET", "x".repeat(44));
      vi.stubEnv("AUTH_MICROSOFT_ENTRA_ID_ID", "app");
      vi.stubEnv("AUTH_MICROSOFT_ENTRA_ID_SECRET", "secret");
      vi.stubEnv("AUTH_MICROSOFT_ENTRA_ID_ISSUER", issuer);
      vi.stubEnv("AUTH_ALLOWED_TENANT_IDS", tenants ?? "");
    };

    it("takes the tenant from a tenant-specific issuer", () => {
      stubAuth(`https://login.microsoftonline.com/${TENANT.toUpperCase()}/v2.0`);
      expect([...allowedTenantIds()]).toEqual([TENANT]);
      expect(tenantOfIssuer("https://login.microsoftonline.com/organizations/v2.0")).toBeNull();
    });

    it("needs the list with the multi-tenant issuer, and reports it as a problem until set", () => {
      stubAuth("https://login.microsoftonline.com/organizations/v2.0");
      expect(allowedTenantIds().size).toBe(0);
      expect(environmentProblems()).toContain("AUTH_ALLOWED_TENANT_IDS is missing (needed with a multi-tenant issuer; nobody can sign in until it is set)");
      stubAuth("https://login.microsoftonline.com/organizations/v2.0", ` ${TENANT}, 11111111-2222-3333-4444-555555555555 `);
      expect([...allowedTenantIds()]).toEqual([TENANT, "11111111-2222-3333-4444-555555555555"]);
      expect(environmentProblems()).not.toContain(expect.stringContaining("AUTH_ALLOWED_TENANT_IDS"));
    });

    it("rejects a list that is not tenant ids, and a short AUTH_SECRET", () => {
      stubAuth("https://login.microsoftonline.com/organizations/v2.0", "api-pharma.net");
      expect(() => authEnv()).toThrow(/tenant ids/);
      stubAuth("https://login.microsoftonline.com/organizations/v2.0", TENANT);
      vi.stubEnv("AUTH_SECRET", "short");
      expect(() => authEnv()).toThrow(/32 characters/);
    });
  });
});
