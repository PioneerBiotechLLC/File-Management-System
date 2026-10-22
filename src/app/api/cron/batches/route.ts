import { bearerMatches } from "@/lib/api-auth";
import { runBatchWork } from "@/lib/batch-reading";
import { db } from "@/lib/db";
import { cronEnv } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Batch reading, every 15 minutes (.github/workflows/cron.yml; Vercel's own cron on this project
 * runs once a day): finished batches in, waiting files out, within the time budget. Called with
 * `Authorization: Bearer $CRON_SECRET`; without one, nothing runs.
 */
export async function GET(request: Request) {
  const { CRON_SECRET } = cronEnv();
  if (!CRON_SECRET) return Response.json({ error: "CRON_SECRET is not set" }, { status: 503 });
  if (!bearerMatches(request, CRON_SECRET)) return new Response(null, { status: 401 });
  const result = await runBatchWork(db(), { budgetMs: 100_000 });
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
