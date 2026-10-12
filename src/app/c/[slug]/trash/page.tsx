import { notFound } from "next/navigation";
import { FileIcon } from "@/components/file-icon";
import { db } from "@/lib/db";
import { fileContext, listDeleted } from "@/lib/files";
import { formatBytes } from "@/lib/file-names";
import { can } from "@/lib/permissions";
import { companyContext } from "@/lib/session";
import { RestoreButton } from "./restore-button";

export const metadata = { title: "Deleted" };

const KEEP_DAYS = 30;

export default async function TrashPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { org, role, user } = await companyContext(slug);
  if (!can(role, "review.accept")) notFound();

  const ctx = await fileContext(db(), { orgId: org.id, userId: user.id, email: user.email, role });
  const deleted = await listDeleted(db(), ctx);
  const formatDate = new Intl.DateTimeFormat("en-GB", { timeZone: org.timezone, dateStyle: "medium" });

  return (
    <div className="grid max-w-4xl gap-4">
      <div>
        <h1 className="text-xl font-semibold">Deleted</h1>
        <p className="text-muted-foreground text-sm">
          Deleted files can be restored for {KEEP_DAYS} days, then they are removed for good.
          {role === "admin" ? " You see everyone's." : " You see your own."}
        </p>
      </div>
      {deleted.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">Nothing has been deleted.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {deleted.map((f) => {
            const purgeOn = f.deletedAt ? new Date(f.deletedAt.getTime() + KEEP_DAYS * 24 * 60 * 60 * 1000) : null;
            return (
              <li key={f.id} className="flex items-center justify-between gap-4 p-4">
                <div className="flex min-w-0 items-start gap-2">
                  <FileIcon name={f.name} mimeType={f.mimeType} className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                  <div className="min-w-0">
                    <p dir="auto" className="truncate font-medium">
                      {f.name}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {f.folderId ? ctx.paths.get(f.folderId) : "Unfiled"} · {formatBytes(f.sizeBytes)} · removed for good on{" "}
                      {purgeOn ? formatDate.format(purgeOn) : "—"}
                    </p>
                  </div>
                </div>
                <RestoreButton slug={slug} fileId={f.id} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
