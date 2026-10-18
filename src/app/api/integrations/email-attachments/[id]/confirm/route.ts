import { after } from "next/server";
import { ZodError } from "zod";
import { bearerMatches } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { confirmEmailAttachment, processEmailAttachment, UnknownCompanyError } from "@/lib/email-attachments";
import { integrationsEnv } from "@/lib/env";
import { UserError } from "@/lib/errors";

export const dynamic = "force-dynamic";
/** The AI read runs after the response, inside this function's time. */
export const maxDuration = 300;

const headers = { "Cache-Control": "no-store" };

/**
 * Step 3: the tracker has PUT the bytes. The file is checked and made real, the answer goes back at
 * once, and the AI reads and files it after the response (a long PDF can take a minute).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!bearerMatches(request, integrationsEnv().FILES_INTEGRATION_API_KEY)) return new Response(null, { status: 401 });
  const { id } = await params;
  let body: { company?: unknown; versionNo?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "The body must be JSON." }, { status: 400, headers });
  }
  try {
    const { status, org } = await confirmEmailAttachment(db(), { company: String(body.company ?? ""), fileId: id, versionNo: Number(body.versionNo) });
    if (status === "processing") {
      after(async () => {
        const outcome = await processEmailAttachment(db(), org, id);
        const filing = outcome.filing ? (outcome.filing.action === "filed" ? `filed in ${outcome.filing.path}` : `review: ${outcome.filing.reason}`) : "left in Review";
        console.log(`email attachment ${id} (${org.slug}): read ${outcome.read.status}, ${filing}`);
      });
    }
    return Response.json({ ok: true, status }, { headers });
  } catch (error) {
    if (error instanceof UnknownCompanyError) return Response.json({ error: error.message }, { status: 404, headers });
    if (error instanceof ZodError) return Response.json({ error: error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ") }, { status: 400, headers });
    if (error instanceof UserError) return Response.json({ error: error.message }, { status: 400, headers });
    throw error;
  }
}
