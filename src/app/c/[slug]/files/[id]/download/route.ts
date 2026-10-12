import { auth } from "@/auth";
import { companyAccess } from "@/lib/companies";
import { db } from "@/lib/db";
import { UserError } from "@/lib/errors";
import { downloadTarget, fileContext } from "@/lib/files";

type Params = { params: Promise<{ slug: string; id: string }> };

/**
 * One-click download (or inline preview with `?inline=1`): checks access, then redirects to a
 * short-lived URL on the bucket. Anything the user may not open is a plain 404.
 */
export async function GET(request: Request, { params }: Params) {
  const { slug, id } = await params;
  const session = await auth();
  if (!session?.user?.id) return new Response(null, { status: 401 });

  const access = await companyAccess(db(), slug, session.user);
  if (!access) return new Response("Not found", { status: 404 });

  const url = new URL(request.url);
  const version = Number(url.searchParams.get("v"));
  try {
    const ctx = await fileContext(db(), { orgId: access.org.id, userId: session.user.id, email: session.user.email, role: access.role });
    const target = await downloadTarget(db(), ctx, {
      fileId: id,
      versionNo: Number.isInteger(version) && version > 0 ? version : undefined,
      inline: url.searchParams.get("inline") === "1",
    });
    return new Response(null, { status: 302, headers: { Location: target.url, "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof UserError) return new Response("Not found", { status: 404 });
    throw error;
  }
}
