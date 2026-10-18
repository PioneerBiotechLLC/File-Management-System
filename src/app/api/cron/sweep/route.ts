import { bearerMatches } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { cronEnv } from "@/lib/env";
import { sweep } from "@/lib/sweep";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Daily housekeeping, called by Vercel Cron with `Authorization: Bearer $CRON_SECRET`. The
 * middleware leaves /api/cron/* open, so the secret is the only lock; without one, nothing runs.
 */
export async function GET(request: Request) {
  const { CRON_SECRET } = cronEnv();
  if (!CRON_SECRET) return Response.json({ error: "CRON_SECRET is not set" }, { status: 503 });
  if (!bearerMatches(request, CRON_SECRET)) return new Response(null, { status: 401 });

  const result = await sweep(db());
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
