import { db } from "@/lib/db";
import { fileContext } from "@/lib/files";
import { companyContext } from "@/lib/session";
import { SearchBox } from "./search-box";

export const metadata = { title: "Search" };

type SearchParams = { q?: string; folder?: string; type?: string; from?: string; to?: string };

export default async function SearchPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> }) {
  const { slug } = await params;
  const query = await searchParams;
  const { org, role, user } = await companyContext(slug);
  const ctx = await fileContext(db(), { orgId: org.id, userId: user.id, email: user.email, role });
  const folders = ctx.folders
    .filter((f) => ctx.visible.has(f.id))
    .map((f) => ({ id: f.id, path: ctx.paths.get(f.id) ?? f.name }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const { ANTHROPIC_API_KEY } = process.env;

  return (
    <SearchBox
      slug={slug}
      folders={folders}
      timezone={org.timezone}
      aiAvailable={Boolean(ANTHROPIC_API_KEY?.trim())}
      initial={{ q: query.q ?? "", folderId: query.folder ?? "", docType: query.type ?? "", dateFrom: query.from ?? "", dateTo: query.to ?? "" }}
    />
  );
}
