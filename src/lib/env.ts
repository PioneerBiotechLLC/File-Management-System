import { z } from "zod";
import { KNOWN_MODELS } from "@/lib/ai-prices";

/**
 * Environment variables, validated with zod and grouped by the part of the app that needs them,
 * so the CLI can run with only a database while the web app checks everything at startup.
 * Values are read from `process.env` at call time, never inlined at build time.
 */

const missingOr = (problem: string) => (issue: { input?: unknown }) => (issue.input === undefined ? "is missing" : problem);
const required = z.string({ error: missingOr("must be text") }).trim().min(1, "is missing");
const url = () => z.url({ error: missingOr("must be a URL") });
const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const nonNegativeInt = (fallback: number) => z.coerce.number().int().nonnegative().default(fallback);
const usd = (fallback: number) => z.coerce.number().nonnegative().default(fallback);
const model = (fallback: string) =>
  z
    .string()
    .trim()
    .min(1)
    .default(fallback)
    .refine((id) => KNOWN_MODELS.includes(id), { message: `must be one of ${KNOWN_MODELS.join(", ")} (a model without a price cannot be charged against the caps)` });

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Comma-separated Entra tenant ids; empty when unset. */
const tenantList = z
  .string()
  .trim()
  .optional()
  .transform((raw) => (raw ? raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : []))
  .refine((ids) => ids.every((id) => GUID.test(id)), { message: "must be a comma-separated list of tenant ids (GUIDs)" });

const groups = {
  database: z.object({
    DATABASE_URL: required,
  }),
  auth: z.object({
    AUTH_SECRET: required.min(32, "must be at least 32 characters (openssl rand -base64 32)"),
    AUTH_MICROSOFT_ENTRA_ID_ID: required,
    AUTH_MICROSOFT_ENTRA_ID_SECRET: required,
    AUTH_MICROSOFT_ENTRA_ID_ISSUER: url().default("https://login.microsoftonline.com/organizations/v2.0"),
    /** Only accounts from these Entra tenants may sign in. The issuer's own tenant, if any, always counts. */
    AUTH_ALLOWED_TENANT_IDS: tenantList,
  }),
  storage: z.object({
    FILES_S3_ENDPOINT: url(),
    FILES_S3_REGION: z.string().trim().min(1).default("auto"),
    FILES_S3_BUCKET: required,
    FILES_S3_ACCESS_KEY_ID: required,
    FILES_S3_SECRET_ACCESS_KEY: required,
  }),
  ai: z.object({
    ANTHROPIC_API_KEY: required,
    ANTHROPIC_MODEL: model("claude-sonnet-5-5"),
    ANTHROPIC_MODEL_LIGHT: model("claude-haiku-5-5"),
    /** 0 switches the AI off entirely. */
    AI_MAX_CALLS_PER_DAY: nonNegativeInt(500),
  }),
  limits: z.object({
    /** Default AI spend caps in USD; a company or a member can be given their own in Usage. */
    AI_DAILY_USD: usd(10),
    AI_MONTHLY_USD: usd(150),
    AI_USER_DAILY_USD: usd(2),
    AI_USER_MONTHLY_USD: usd(30),
    /** The most any cap may be set to in Usage. Only the operator, through the environment, can raise these. */
    AI_DAILY_USD_MAX: usd(50),
    AI_MONTHLY_USD_MAX: usd(500),
    /** Largest upload. Anything over FILES_AI_MAX_MB is stored but waits in Review for a person to file it. */
    FILES_MAX_MB: positiveInt(1900),
    /** Files larger than this are not read by the AI; the uploader writes the summary. */
    FILES_AI_MAX_MB: positiveInt(22),
    FILES_AI_SEARCHES_PER_USER_PER_DAY: positiveInt(50),
    DATA_ENCRYPTION_KEY: z
      .string()
      .trim()
      .refine((v) => Buffer.from(v, "base64").length === 32, {
        message: "must be 32 bytes, base64-encoded (openssl rand -base64 32)",
      })
      .optional(),
  }),
  cron: z.object({
    /** Bearer token Vercel Cron sends to /api/cron/*. The sweep refuses to run without it. */
    CRON_SECRET: z.string().trim().min(16, "must be at least 16 characters (openssl rand -base64 32)").optional(),
  }),
} as const;

type Groups = typeof groups;
type GroupName = keyof Groups;
type GroupEnv<G extends GroupName> = z.infer<Groups[G]>;

/** Treats empty strings as unset, so `FOO=` in a .env file falls back to the default. */
function source(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && value.trim() !== "") out[key] = value;
  }
  return out;
}

function problemsOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`);
}

/** Thrown when a part of the app is used without its environment variables. */
export class EnvError extends Error {
  constructor(group: string, problems: string[]) {
    super(`Environment variables for ${group}: ${problems.join("; ")}. See .env.example.`);
    this.name = "EnvError";
  }
}

function readGroup<G extends GroupName>(group: G): GroupEnv<G> {
  const parsed = groups[group].safeParse(source());
  if (!parsed.success) throw new EnvError(group, problemsOf(parsed.error));
  return parsed.data as GroupEnv<G>;
}

export const databaseEnv = () => readGroup("database");
export const authEnv = () => readGroup("auth");
export const storageEnv = () => readGroup("storage");
export const aiEnv = () => readGroup("ai");
export const limitsEnv = () => readGroup("limits");
export const cronEnv = () => readGroup("cron");

/** The tenant a tenant-specific issuer URL names, or null for the multi-tenant endpoints. */
export function tenantOfIssuer(issuer: string): string | null {
  const match = issuer.match(/login\.microsoftonline\.com\/([^/]+)\//i);
  const tenant = match?.[1]?.toLowerCase();
  return tenant && GUID.test(tenant) ? tenant : null;
}

/**
 * Entra tenants whose accounts may sign in: AUTH_ALLOWED_TENANT_IDS plus the issuer's tenant.
 * Empty means nobody can sign in; the multi-tenant issuer needs the list.
 */
export function allowedTenantIds(): Set<string> {
  const { AUTH_ALLOWED_TENANT_IDS, AUTH_MICROSOFT_ENTRA_ID_ISSUER } = authEnv();
  const ids = new Set(AUTH_ALLOWED_TENANT_IDS);
  const own = tenantOfIssuer(AUTH_MICROSOFT_ENTRA_ID_ISSUER);
  if (own) ids.add(own);
  return ids;
}

/** Every problem across all groups, as readable lines. Empty when the environment is complete. */
export function environmentProblems(): string[] {
  const env = source();
  const problems = Object.values(groups).flatMap((schema) => {
    const parsed = schema.safeParse(env);
    return parsed.success ? [] : problemsOf(parsed.error);
  });
  const auth = groups.auth.safeParse(env);
  if (auth.success && auth.data.AUTH_ALLOWED_TENANT_IDS.length === 0 && !tenantOfIssuer(auth.data.AUTH_MICROSOFT_ENTRA_ID_ISSUER)) {
    problems.push("AUTH_ALLOWED_TENANT_IDS is missing (needed with a multi-tenant issuer; nobody can sign in until it is set)");
  }
  return problems;
}
