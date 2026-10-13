import { ChevronRight, ChevronsUpDown, Lock } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FileIcon } from "@/components/file-icon";
import { FolderTree } from "@/components/folder-tree";
import { UploadButton } from "@/components/upload-buttons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { db } from "@/lib/db";
import { fileContext, listFiles, type ListFilesOptions } from "@/lib/files";
import { formatBytes } from "@/lib/file-names";
import { can } from "@/lib/permissions";
import { companyContext } from "@/lib/session";
import { AskBox } from "./search/ask-box";

type SearchParams = { folder?: string; sort?: string; dir?: string; page?: string };

const SORTS = ["name", "createdAt", "sizeBytes"] as const;

function href(slug: string, params: SearchParams, change: Partial<SearchParams>): string {
  const merged = { ...params, ...change };
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) if (value) query.set(key, value);
  const text = query.toString();
  return `/c/${slug}${text ? `?${text}` : ""}`;
}

export default async function CompanyHome({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> }) {
  const { slug } = await params;
  const query = await searchParams;
  const { org, role, user } = await companyContext(slug);
  const prisma = db();
  const ctx = await fileContext(prisma, { orgId: org.id, userId: user.id, email: user.email, role });

  // A folder the user cannot see is a 404, the same as one that does not exist.
  const folderId = query.folder;
  if (folderId && !ctx.visible.has(folderId)) notFound();
  const folder = folderId ? ctx.folders.find((f) => f.id === folderId) : undefined;

  const sort = (SORTS as readonly string[]).includes(query.sort ?? "") ? (query.sort as NonNullable<ListFilesOptions["sort"]>) : undefined;
  const dir = query.dir === "asc" || query.dir === "desc" ? query.dir : undefined;
  const result = await listFiles(prisma, ctx, { folderId, sort, dir, page: Number(query.page) || 1 });

  const treeFolders = ctx.folders.filter((f) => ctx.visible.has(f.id) && f.isActive);
  const crumbs: { id: string; name: string }[] = [];
  for (let f = folder; f && crumbs.length < 10; f = f.parentId ? ctx.folders.find((p) => p.id === f!.parentId) : undefined) crumbs.unshift(f);
  const children = folder ? treeFolders.filter((f) => f.parentId === folder.id) : [];

  const effectiveSort = sort ?? "createdAt";
  const effectiveDir = dir ?? (effectiveSort === "name" ? "asc" : "desc");
  const sortLink = (key: (typeof SORTS)[number]) =>
    href(slug, query, { sort: key, dir: effectiveSort === key && effectiveDir === "asc" ? "desc" : "asc", page: undefined });
  const dateFormat = new Intl.DateTimeFormat("en-GB", { timeZone: org.timezone, dateStyle: "medium" });
  const SortHead = ({ column, children, className }: { column: (typeof SORTS)[number]; children: React.ReactNode; className?: string }) => (
    <TableHead className={className} aria-sort={effectiveSort === column ? (effectiveDir === "asc" ? "ascending" : "descending") : "none"}>
      <Link href={sortLink(column)} className="hover:text-foreground inline-flex items-center gap-1">
        {children}
        <ChevronsUpDown className={effectiveSort === column ? "size-3" : "text-muted-foreground size-3 opacity-50"} />
      </Link>
    </TableHead>
  );

  return (
    <div className="grid gap-6 md:grid-cols-[16rem_1fr]">
      <aside className="max-h-72 overflow-y-auto md:max-h-none">
        <FolderTree
          slug={slug}
          selectedId={folderId}
          folders={treeFolders.map((f) => ({ id: f.id, parentId: f.parentId, name: f.name, nameAr: f.nameAr, access: f.access }))}
        />
      </aside>

      <section className="grid min-w-0 content-start gap-4">
        <AskBox
          slug={slug}
          aiAvailable={Boolean(process.env.ANTHROPIC_API_KEY?.trim())}
          folder={folder ? { id: folder.id, name: folder.name } : undefined}
          className="max-w-3xl"
        />

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <nav aria-label="Breadcrumb" className="text-muted-foreground flex flex-wrap items-center gap-1 text-sm">
              <Link href={`/c/${slug}`} className="hover:text-foreground">
                Files
              </Link>
              {crumbs.map((c) => (
                <span key={c.id} className="flex items-center gap-1">
                  <ChevronRight className="size-3" />
                  <Link href={`/c/${slug}?folder=${c.id}`} dir="auto" className="hover:text-foreground">
                    {c.name}
                  </Link>
                </span>
              ))}
            </nav>
            <h1 dir="auto" className="mt-1 flex items-center gap-2 text-xl font-semibold">
              {folder ? folder.name : "Recent files"}
              {folder?.access === "restricted" && <Lock className="text-muted-foreground size-4" aria-label="Restricted" />}
              {folder && !folder.isActive && <Badge variant="outline">Inactive</Badge>}
            </h1>
            {folder?.description && (
              <p dir="auto" className="text-muted-foreground mt-1 max-w-2xl text-sm">
                {folder.description}
              </p>
            )}
          </div>
          {can(role, "file.upload") && (!folder || ctx.writable.has(folder.id)) && <UploadButton />}
        </div>

        {children.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {children.map((c) => (
              <Button key={c.id} asChild variant="outline" size="sm">
                <Link href={`/c/${slug}?folder=${c.id}`} dir="auto">
                  {c.name}
                </Link>
              </Button>
            ))}
          </div>
        )}

        {result.items.length === 0 ? (
          <div className="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
            {folder ? "No files in this folder yet." : "No files yet."}
            {can(role, "file.upload") && " Drop files anywhere on this page, or use Upload."}
          </div>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <SortHead column="name">Name</SortHead>
                  {!folder && <TableHead>Folder</TableHead>}
                  <SortHead column="createdAt">Added</SortHead>
                  <SortHead column="sizeBytes" className="text-right">
                    Size
                  </SortHead>
                  <TableHead>By</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.items.map((f) => (
                  <TableRow key={f.id}>
                    <TableCell className="max-w-md min-w-56 whitespace-normal">
                      <Link href={`/c/${slug}/files/${f.id}`} className="flex items-start gap-2">
                        <FileIcon name={f.name} mimeType={f.mimeType} className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                        <span className="min-w-0">
                          <span dir="auto" className="block truncate font-medium hover:underline">
                            {f.name}
                          </span>
                          {(f.title || f.summary) && (
                            <span dir="auto" className="text-muted-foreground block truncate text-xs">
                              {f.title && f.title !== f.name ? f.title : (f.summary ?? "").split("\n")[0]}
                            </span>
                          )}
                        </span>
                      </Link>
                    </TableCell>
                    {!folder && (
                      <TableCell className="text-muted-foreground">
                        {f.folderId ? (ctx.paths.get(f.folderId) ?? "") : <Badge variant="outline">Unfiled</Badge>}
                      </TableCell>
                    )}
                    <TableCell className="text-muted-foreground">{dateFormat.format(f.createdAt)}</TableCell>
                    <TableCell className="text-muted-foreground text-right">{formatBytes(f.sizeBytes)}</TableCell>
                    <TableCell className="text-muted-foreground max-w-40 truncate">{f.uploader.name ?? f.uploader.email}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {result.pages > 1 && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              Page {result.page} of {result.pages} · {result.total} files
            </span>
            <div className="flex gap-2">
              {result.page > 1 && (
                <Button asChild variant="outline" size="sm">
                  <Link href={href(slug, query, { page: String(result.page - 1) })}>Previous</Link>
                </Button>
              )}
              {result.page < result.pages && (
                <Button asChild variant="outline" size="sm">
                  <Link href={href(slug, query, { page: String(result.page + 1) })}>Next</Link>
                </Button>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
