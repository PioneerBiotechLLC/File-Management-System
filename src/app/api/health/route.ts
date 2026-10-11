import { db } from "@/lib/db";
import { EnvError, environmentProblems } from "@/lib/env";
import { checkBucket } from "@/lib/storage";

export const dynamic = "force-dynamic";

const TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} did not answer within ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)),
  ]);
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200);

/** Missing variables are already listed once from environmentProblems(). */
function addReason(reasons: string[], part: string, error: unknown) {
  if (!(error instanceof EnvError)) reasons.push(`${part}: ${message(error)}`);
}

/** Public status check: `ok` is false, with the reason, when anything required is missing or down. */
export async function GET() {
  const reasons = environmentProblems();
  const { ANTHROPIC_API_KEY } = process.env;

  const database = { ok: false, latencyMs: null as number | null };
  try {
    const started = performance.now();
    await withTimeout(db().$queryRaw`SELECT 1`, "Database");
    database.ok = true;
    database.latencyMs = Math.round(performance.now() - started);
  } catch (error) {
    addReason(reasons, "database", error);
  }

  const storage = { ok: false };
  try {
    await withTimeout(checkBucket(), "Storage");
    storage.ok = true;
  } catch (error) {
    addReason(reasons, "storage", error);
  }

  const ok = reasons.length === 0;
  return Response.json(
    { ok, ...(ok ? {} : { reason: reasons.join("; ") }), db: database, storage, ai: { configured: Boolean(ANTHROPIC_API_KEY?.trim()) } },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
