import Link from "next/link";
import { notFound } from "next/navigation";
import { FileIcon } from "@/components/file-icon";
import { db } from "@/lib/db";
import { fileContext, listUnfiled } from "@/lib/files";
import { formatBytes } from "@/lib/file-names";
import { can } from "@/lib/permissions";
import { companyContext } from "@/lib/session";
import { ReviewRow } from "./review-row";

export const metadata = { title: "Review" };

export default async function ReviewPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { org, role, user } = await companyContext(slug);
  if (!can(role, "review.accept")) notFound();

  const ctx = await fileContext(db(), { orgId: org.id, userId: user.id, email: user.email, role });
  const waiting = await listUnfiled(db(), ctx);
  const folders = ctx.folders
    .filter((f) => ctx.writable.has(f.id))
    .map((f) => ({ id: f.id, path: ctx.paths.get(f.id) ?? f.name }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const formatDate = new Intl.DateTimeFormat("en-GB", { timeZone: org.timezone, dateStyle: "medium", timeStyle: "short" });

  return (
    <div className="grid max-w-4xl gap-4">
      <div>
        <h1 className="text-xl font-semibold">Review</h1>
        <p className="text-muted-foreground text-sm">
          Files uploaded without a folder. Choose where each one belongs.
          {role === "admin" ? " You see everyone's." : " You see your own."}
        </p>
      </div>
      {waiting.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">Nothing is waiting. Every file is filed.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {waiting.map((f) => (
            <li key={f.id} className="grid gap-3 p-4 md:grid-cols-[1fr_24rem] md:items-center">
              <div className="flex min-w-0 items-start gap-2">
                <FileIcon name={f.name} mimeType={f.mimeType} className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                <div className="min-w-0">
                  <Link href={`/c/${slug}/files/${f.id}`} dir="auto" className="block truncate font-medium hover:underline">
                    {f.name}
                  </Link>
                  <p className="text-muted-foreground text-xs">
                    {formatBytes(f.sizeBytes)} · {f.uploader.name ?? f.uploader.email} · {formatDate.format(f.createdAt)}
                  </p>
                </div>
              </div>
              <ReviewRow slug={slug} fileId={f.id} folders={folders} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
