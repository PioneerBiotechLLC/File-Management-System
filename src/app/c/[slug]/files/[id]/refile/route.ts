import { auth } from "@/auth";
import { companyAccess } from "@/lib/companies";
import { db } from "@/lib/db";
import { UserError } from "@/lib/errors";
import { fileContext } from "@/lib/files";
import { refileOne, type RefileOutcome } from "@/lib/refile";

type Params = { params: Promise<{ slug: string; id: string }> };

export const maxDuration = 120;

export type RefileResult = { outcome: RefileOutcome } | { error: string };

/** Re-reads one stored file and moves it where the current rules put it (`?apply=1`), or only says where. Admins only. */
export async function POST(request: Request, { params }: Params) {
  const { slug, id } = await params;
  const session = await auth();
  if (!session?.user?.id) return new Response(null, { status: 401 });
  const access = await companyAccess(db(), slug, session.user);
  if (!access || access.role !== "admin") return new Response("Not found", { status: 404 });
  try {
    const ctx = await fileContext(db(), { orgId: access.org.id, userId: session.user.id, email: session.user.email, role: access.role });
    const outcome = await refileOne(db(), ctx, access.org, id, { apply: new URL(request.url).searchParams.get("apply") === "1" });
    return Response.json({ outcome } satisfies RefileResult, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof UserError) return Response.json({ error: error.message } satisfies RefileResult, { status: 400 });
    throw error;
  }
}
