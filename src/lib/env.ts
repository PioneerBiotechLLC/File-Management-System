import { z } from "zod";

/**
 * Environment variables, validated with zod and grouped by the part of the app that needs them,
 * so the CLI can run with only a database while the web app checks everything at startup.
 * Values are read from `process.env` at call time, never inlined at build time.
 */

const missingOr = (problem: string) => (issue: { input?: unknown }) => (issue.input === undefined ? "is missing" : problem);
const required = z.string({ error: missingOr("must be text") }).trim().min(1, "is missing");
const url = () => z.url({ error: missingOr("must be a URL") });
const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const groups = {
  database: z.object({
    DATABASE_URL: required,
  }),
  auth: z.object({
    AUTH_SECRET: required,
    AUTH_MICROSOFT_ENTRA_ID_ID: required,
    AUTH_MICROSOFT_ENTRA_ID_SECRET: required,
    AUTH_MICROSOFT_ENTRA_ID_ISSUER: url().default("https://login.microsoftonline.com/organizations/v2.0"),
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
    ANTHROPIC_MODEL: z.string().trim().min(1).default("claude-sonnet-5-5"),
    ANTHROPIC_MODEL_LIGHT: z.string().trim().min(1).default("claude-haiku-5-5"),
    AI_MAX_CALLS_PER_DAY: positiveInt(500),
  }),
  limits: z.object({
    FILES_MAX_MB: positiveInt(100),
    FILES_AUTO_FILE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.75),
    FILES_AI_SEARCHES_PER_USER_PER_DAY: positiveInt(50),
    DATA_ENCRYPTION_KEY: z
      .string()
      .trim()
      .refine((v) => Buffer.from(v, "base64").length === 32, {
        message: "must be 32 bytes, base64-encoded (openssl rand -base64 32)",
      })
      .optional(),
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
export const storageEnv = () => readGroup("storage");
export const aiEnv = () => readGroup("ai");
export const limitsEnv = () => readGroup("limits");

/** Every problem across all groups, as readable lines. Empty when the environment is complete. */
export function environmentProblems(): string[] {
  const env = source();
  return Object.values(groups).flatMap((schema) => {
    const parsed = schema.safeParse(env);
    return parsed.success ? [] : problemsOf(parsed.error);
  });
}
