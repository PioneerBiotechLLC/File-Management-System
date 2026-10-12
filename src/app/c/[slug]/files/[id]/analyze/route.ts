import { auth } from "@/auth";
import { companyAccess } from "@/lib/companies";
import { db } from "@/lib/db";
import { UserError } from "@/lib/errors";
import { fileContext } from "@/lib/files";
import { readUpload } from "@/lib/intake";

type Params = { params: Promise<{ slug: string; id: string }> };

/** Reading a long PDF can take a while; the browser waits for this response. */
export const maxDuration = 120;

/**
 * Has the AI read a freshly uploaded file and draft its summary. The browser calls this right after
 * the upload is confirmed; calling it again for a finished file just reports the state.
 */
export async function POST(_request: Request, { params }: Params) {
  const { slug, id } = await params;
  const session = await auth();
  if (!session?.user?.id) return new Response(null, { status: 401 });

  const access = await companyAccess(db(), slug, session.user);
  if (!access) return new Response("Not found", { status: 404 });

  try {
    const ctx = await fileContext(db(), { orgId: access.org.id, userId: session.user.id, email: session.user.email, role: access.role });
    const outcome = await readUpload(db(), ctx, access.org, id);
    return Response.json(outcome, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof UserError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
