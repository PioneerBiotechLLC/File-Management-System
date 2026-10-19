import { bearerMatches } from "@/lib/api-auth";
import { collectBatches, submitWaiting } from "@/lib/batch-reading";
import { db } from "@/lib/db";
import { cronEnv } from "@/lib/env";
import { sweep } from "@/lib/sweep";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Daily housekeeping, called by Vercel Cron with `Authorization: Bearer $CRON_SECRET`. The
 * middleware leaves /api/cron/* open, so the secret is the only lock; without one, nothing runs.
 */
export async function GET(request: Request) {
  const { CRON_SECRET } = cronEnv();
  if (!CRON_SECRET) return Response.json({ error: "CRON_SECRET is not set" }, { status: 503 });
  if (!bearerMatches(request, CRON_SECRET)) return new Response(null, { status: 401 });

  const result = await sweep(db());
  // Batch reading left behind (the bulk page was closed): one batch in, one batch out per run.
  let batches: unknown = null;
  try {
    batches = { collected: await collectBatches(db(), { limit: 1 }), sent: await submitWaiting(db()) };
  } catch (error) {
    batches = { error: error instanceof Error ? error.message : String(error) };
  }
  return Response.json({ ...result, batches }, { headers: { "Cache-Control": "no-store" } });
}
