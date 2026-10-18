import { auth } from "@/auth";
import { companyAccess } from "@/lib/companies";
import { db } from "@/lib/db";
import { writeFactsCsv } from "@/lib/facts-csv";
import { fileContext, getFile } from "@/lib/files";
import { can } from "@/lib/permissions";
import { factsKey, head, presignDownload } from "@/lib/storage";

type Params = { params: Promise<{ slug: string; id: string }> };

/**
 * Downloads a file's facts CSV from the bucket (see facts-csv.ts), for anyone who may download
 * the file itself. A CSV that was never written (a file from before the feature) is written first.
 */
export async function GET(_request: Request, { params }: Params) {
  const { slug, id } = await params;
  const session = await auth();
  if (!session?.user?.id) return new Response(null, { status: 401 });

  const access = await companyAccess(db(), slug, session.user);
  if (!access || !can(access.role, "file.download")) return new Response("Not found", { status: 404 });

  const ctx = await fileContext(db(), { orgId: access.org.id, userId: session.user.id, email: session.user.email, role: access.role });
  const file = await getFile(db(), ctx, id);
  if (!file || file.deletedAt || file.folderId === null) return new Response("Not found", { status: 404 });

  const key = factsKey(access.org.id, file.id);
  if (!(await head(key)) && !(await writeFactsCsv(db(), file.id))) return new Response("Not found", { status: 404 });
  const url = await presignDownload(key, `${file.name}.facts.csv`, { contentType: "text/csv; charset=utf-8" });
  return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store" } });
}
