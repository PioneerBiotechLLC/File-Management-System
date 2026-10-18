import { Download, Lock } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FileIcon } from "@/components/file-icon";
import { NewVersionButton } from "@/components/upload-buttons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/lib/db";
import { DOC_TYPE_LABELS, type DocType } from "@/lib/doc-types";
import { docKindForType, TECHNICAL_DOC_TYPES, techKindForType } from "@/lib/file-kinds";
import { fileContext, getFile } from "@/lib/files";
import { destinationOf, filingYear, listMaterials, listParties } from "@/lib/parties";
import { formatBytes, previewKind } from "@/lib/file-names";
import { can } from "@/lib/permissions";
import { companyContext } from "@/lib/session";
import { DetailsForm, MoveForm, RenameAndDelete } from "./file-forms";

export async function generateMetadata({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const { org, role, user } = await companyContext(slug);
  const ctx = await fileContext(db(), { orgId: org.id, userId: user.id, email: user.email, role });
  return { title: (await getFile(db(), ctx, id))?.name ?? "File" };
}

type Facts = { parties?: string[]; references?: { kind: string; value: string }[]; amounts?: { value: number; currency: string }[]; products?: string[]; expiryDate?: string };

function FactsTable({ facts }: { facts: Facts }) {
  const rows: [string, string][] = [];
  if (facts.parties?.length) rows.push(["Parties", facts.parties.join(", ")]);
  for (const r of facts.references ?? []) rows.push([r.kind, r.value]);
  if (facts.amounts?.length) rows.push(["Amounts", facts.amounts.map((a) => `${a.value.toLocaleString("en")} ${a.currency}`).join(", ")]);
  if (facts.products?.length) rows.push(["Products", facts.products.join(", ")]);
  if (facts.expiryDate) rows.push(["Expires", facts.expiryDate]);
  if (rows.length === 0) return null;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted-foreground capitalize">{k.replaceAll("_", " ")}</dt>
          <dd dir="auto">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function FilePage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const { org, role, user } = await companyContext(slug);
  const prisma = db();
  const ctx = await fileContext(prisma, { orgId: org.id, userId: user.id, email: user.email, role });
  const file = await getFile(prisma, ctx, id);
  if (!file) notFound();

  const owns = file.uploadedBy === user.id;
  const canEdit = can(role, "file.rename", { ownsFile: owns });
  const canMove = file.folderId === null ? can(role, "review.accept") && (owns || role === "admin") : can(role, "file.move", { ownsFile: owns });
  const canDelete = can(role, "file.delete", { ownsFile: owns });
  // Company folders only; customer and supplier folders are chosen by year, company and kind.
  const folderOptions = ctx.folders
    .filter((f) => f.kind === "regular" && ctx.writable.has(f.id))
    .map((f) => ({ id: f.id, path: ctx.paths.get(f.id) ?? f.name }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const parties = canMove ? await listParties(prisma, org.id) : [];
  const materials = canMove ? await listMaterials(prisma, org.id) : [];
  const current = destinationOf(file.folderId, ctx, parties, materials);
  const moveDefaults = {
    year: filingYear(file.docDate, file.createdAt, org.timezone),
    docKind: docKindForType(file.docType as DocType | null),
    techKind: techKindForType(file.docType as DocType | null),
    technical: TECHNICAL_DOC_TYPES.includes(file.docType as DocType),
  };

  const base = `/c/${slug}/files/${file.id}/download`;
  const preview = previewKind(file.mimeType);
  const formatDate = new Intl.DateTimeFormat("en-GB", { timeZone: org.timezone, dateStyle: "medium", timeStyle: "short" });
  const uploader = file.uploader.name ?? file.uploader.email;
  const facts = file.facts as Facts;
  const docDate = file.docDate?.toISOString().slice(0, 10) ?? "";
  const readByAi = file.readStatus === "full" || file.readStatus === "partial";
  const summaryNote = file.summaryConfirmedAt
    ? `${readByAi ? `Read by the AI (${file.aiModel ?? "Claude"}); summary` : "Summary written and"} confirmed by ${file.summaryConfirmedBy ?? "someone"} on ${formatDate.format(file.summaryConfirmedAt)}.`
    : file.folderId === null
      ? "Not confirmed yet."
      : "This file was filed before summaries were confirmed.";

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <nav className="text-muted-foreground text-sm">
            <Link href={file.folderId ? `/c/${slug}?folder=${file.folderId}` : `/c/${slug}`} className="hover:text-foreground">
              ← {file.folderPath ?? "All files"}
            </Link>
          </nav>
          <h1 dir="auto" className="mt-1 flex items-center gap-2 text-xl font-semibold break-words">
            <FileIcon name={file.name} mimeType={file.mimeType} className="text-muted-foreground size-5 shrink-0" />
            {file.name}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {formatBytes(file.sizeBytes)} · version {file.currentVersion} · added by {uploader} on {formatDate.format(file.createdAt)}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {file.folderId === null && (
              <Link href={`/c/${slug}/review?file=${file.id}`}>
                <Badge variant="outline">Waiting in Review</Badge>
              </Link>
            )}
            {file.unsure && (
              <Badge variant="outline" title="The AI found no place for this file in the tree. Moving it clears this.">
                Unsure
              </Badge>
            )}
            {file.folderId && ctx.restricted.has(file.folderId) && (
              <Badge variant="secondary">
                <Lock /> Restricted
              </Badge>
            )}
            {file.docType && <Badge variant="secondary">{DOC_TYPE_LABELS[file.docType as DocType] ?? file.docType}</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <a href={base}>
              <Download />
              Download
            </a>
          </Button>
          {canEdit && <NewVersionButton fileId={file.id} />}
        </div>
      </div>

      {preview === "pdf" && (
        <iframe src={`${base}?inline=1`} title={`Preview of ${file.name}`} className="h-[75vh] w-full rounded-lg border bg-white" />
      )}
      {preview === "image" && (
        <div className="flex justify-center rounded-lg border bg-muted/30 p-4">
          {/* eslint-disable-next-line @next/next/no-img-element -- served from a short-lived storage URL */}
          <img src={`${base}?inline=1`} alt={file.title ?? file.name} className="max-h-[75vh] max-w-full object-contain" />
        </div>
      )}
      {!preview && (
        <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
          This type of file cannot be previewed in the browser. Use Download to open it.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
            <CardDescription>{summaryNote}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            {canEdit ? (
              <DetailsForm
                slug={slug}
                fileId={file.id}
                initial={{ title: file.title ?? "", summary: file.summary ?? "", docType: file.docType ?? "", docDate, tags: file.tags.join(", ") }}
              />
            ) : (
              <div className="grid gap-3 text-sm">
                {file.title && <p dir="auto" className="font-medium">{file.title}</p>}
                {file.summary && <p dir="auto">{file.summary}</p>}
                {file.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {file.tags.map((t) => (
                      <Badge key={t} variant="outline" dir="auto">
                        {t}
                      </Badge>
                    ))}
                  </div>
                )}
                {!file.title && !file.summary && file.tags.length === 0 && <p className="text-muted-foreground">No details have been added.</p>}
              </div>
            )}
            <FactsTable facts={facts} />
          </CardContent>
        </Card>

        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Folder</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              <p dir="auto">{file.folderPath ?? "Not filed yet"}</p>
              {file.filedBy && <p className="text-muted-foreground">Filed by {file.filedBy === "ai" ? "AI" : file.filedBy}</p>}
              {canMove && (
                <MoveForm
                  slug={slug}
                  fileId={file.id}
                  current={current}
                  defaults={moveDefaults}
                  parties={parties.map((p) => ({ id: p.id, side: p.side, name: p.name, aliases: p.aliases }))}
                  materials={materials.map((m) => ({ id: m.id, partyId: m.partyId, name: m.name, aliases: m.aliases }))}
                  folders={folderOptions}
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Versions</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="divide-y text-sm">
                {file.versions.map((v) => (
                  <li key={v.versionNo} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <div className="font-medium">
                        Version {v.versionNo}
                        {v.versionNo === file.currentVersion && <span className="text-muted-foreground font-normal"> · current</span>}
                      </div>
                      <div className="text-muted-foreground truncate text-xs" dir="auto">
                        {formatDate.format(v.createdAt)} · {formatBytes(v.sizeBytes)}
                      </div>
                    </div>
                    <Button asChild variant="outline" size="sm">
                      <a href={`${base}?v=${v.versionNo}`} aria-label={`Download version ${v.versionNo}`}>
                        <Download />
                      </a>
                    </Button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          {(canEdit || canDelete) && (
            <RenameAndDelete
              slug={slug}
              fileId={file.id}
              name={file.name}
              canRename={canEdit}
              canDelete={canDelete}
              backHref={file.folderId ? `/c/${slug}?folder=${file.folderId}` : `/c/${slug}`}
            />
          )}
        </div>
      </div>
    </div>
  );
}
