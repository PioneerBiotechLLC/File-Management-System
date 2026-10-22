import { bearerMatches } from "@/lib/api-auth";
import { runBatchWork } from "@/lib/batch-reading";
import { db } from "@/lib/db";
import { readWaitingEmailAttachments } from "@/lib/email-attachments";
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
  // Batch reading left behind; /api/cron/batches does the same every 15 minutes.
  const batches = await runBatchWork(db(), { budgetMs: 40_000 });
  // Email attachments the tracker confirmed faster than they could be read.
  let emailAttachments: unknown = null;
  try {
    emailAttachments = { read: await readWaitingEmailAttachments(db(), 60_000) };
  } catch (error) {
    emailAttachments = { error: error instanceof Error ? error.message : String(error) };
  }
  return Response.json({ ...result, batches, emailAttachments }, { headers: { "Cache-Control": "no-store" } });
}
