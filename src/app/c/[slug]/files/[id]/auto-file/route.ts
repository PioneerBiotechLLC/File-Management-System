import { auth } from "@/auth";
import { autoFileAfterRead, type BulkOutcome } from "@/lib/bulk";
import { companyAccess } from "@/lib/companies";
import { db } from "@/lib/db";
import { UserError } from "@/lib/errors";
import { fileContext } from "@/lib/files";
import { readUpload, retryRead } from "@/lib/intake";

type Params = { params: Promise<{ slug: string; id: string }> };

export const maxDuration = 120;

export type AutoFileResult = { status: "done"; outcome: BulkOutcome } | { status: "busy" } | { error: string };

/**
 * Bulk upload: has the AI read a freshly uploaded file, then files it at once when the AI was sure
 * enough; otherwise it stays in Review. Admins only. "busy" means another of the admin's AI calls
 * is still running; the browser asks again.
 */
export async function POST(request: Request, { params }: Params) {
  const { slug, id } = await params;
  const session = await auth();
  if (!session?.user?.id) return new Response(null, { status: 401 });

  const access = await companyAccess(db(), slug, session.user);
  if (!access || access.role !== "admin") return new Response("Not found", { status: 404 });

  try {
    const ctx = await fileContext(db(), { orgId: access.org.id, userId: session.user.id, email: session.user.email, role: access.role });
    // A read that failed earlier (an API error, say) can be tried again from the bulk page.
    if (new URL(request.url).searchParams.get("retry") === "1") await retryRead(db(), ctx, id).catch(() => undefined);
    const read = await readUpload(db(), ctx, access.org, id);
    if (read.status === "busy") return Response.json({ status: "busy" } satisfies AutoFileResult, { headers: { "Cache-Control": "no-store" } });
    const outcome = await autoFileAfterRead(db(), ctx, access.org, id);
    return Response.json({ status: "done", outcome } satisfies AutoFileResult, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof UserError) return Response.json({ error: error.message } satisfies AutoFileResult, { status: 400 });
    throw error;
  }
}
