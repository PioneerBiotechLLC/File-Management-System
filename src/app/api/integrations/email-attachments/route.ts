import { ZodError } from "zod";
import { bearerMatches } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { startEmailAttachment, UnknownCompanyError } from "@/lib/email-attachments";
import { integrationsEnv } from "@/lib/env";
import { UserError } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const headers = { "Cache-Control": "no-store" };

/**
 * Step 1 of an email attachment coming from the Email Tracker: `Authorization: Bearer
 * $FILES_INTEGRATION_API_KEY`, a JSON body (src/lib/email-attachments.ts), and the answer says
 * where to PUT the bytes, or that an identical file already exists. The middleware leaves
 * /api/integrations/* open, so the key is the only lock; without one, nothing is accepted.
 */
export async function POST(request: Request) {
  if (!bearerMatches(request, integrationsEnv().FILES_INTEGRATION_API_KEY)) return new Response(null, { status: 401 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "The body must be JSON." }, { status: 400, headers });
  }
  try {
    return Response.json(await startEmailAttachment(db(), body as Parameters<typeof startEmailAttachment>[1]), { headers });
  } catch (error) {
    if (error instanceof UnknownCompanyError) return Response.json({ error: error.message }, { status: 404, headers });
    if (error instanceof ZodError) return Response.json({ error: error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ") }, { status: 400, headers });
    if (error instanceof UserError) return Response.json({ error: error.message }, { status: 400, headers });
    throw error;
  }
}
