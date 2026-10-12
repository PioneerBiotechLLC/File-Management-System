import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { fileKindsFor } from "@/lib/file-kinds";
import { fileContext, listUnfiled } from "@/lib/files";
import { MAX_READ_ATTEMPTS, READ_TIMEOUT_MS, summaryToForm } from "@/lib/intake";
import { can } from "@/lib/permissions";
import { companyContext } from "@/lib/session";
import { ReadingWatch } from "./reading-watch";
import { ReviewCard, type ReviewFile } from "./review-card";

export const metadata = { title: "Review" };

export default async function ReviewPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ file?: string }> }) {
  const { slug } = await params;
  const { file: focusId } = await searchParams;
  const { org, role, user } = await companyContext(slug);
  if (!can(role, "review.accept")) notFound();

  const ctx = await fileContext(db(), { orgId: org.id, userId: user.id, email: user.email, role });
  const waiting = await listUnfiled(db(), ctx);
  const folders = ctx.folders
    .filter((f) => f.isActive && ctx.writable.has(f.id))
    .map((f) => ({ id: f.id, path: ctx.paths.get(f.id) ?? f.name }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const kinds = fileKindsFor(ctx.paths, ctx.writable);
  const formatDate = new Intl.DateTimeFormat("en-GB", { timeZone: org.timezone, dateStyle: "medium", timeStyle: "short" });
  const now = Date.now();

  const files: ReviewFile[] = waiting.map((f) => {
    const readByAi = f.readStatus === "full" || f.readStatus === "partial";
    const reading = f.status === "processing" && f.processingStartedAt !== null && now - f.processingStartedAt.getTime() < READ_TIMEOUT_MS;
    const step = reading ? "reading" : f.summaryConfirmedAt ? "folder" : "summary";
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      sizeBytes: f.sizeBytes,
      uploader: f.uploader.name ?? f.uploader.email,
      uploadedAt: formatDate.format(f.createdAt),
      step,
      readByAi,
      aiNote: f.status === "processing" && !reading ? "The AI did not finish reading this file." : (f.aiError ?? null),
      retryable: !readByAi && f.attempts < MAX_READ_ATTEMPTS && (f.status === "processing" || (f.readStatus === null && f.aiError !== null)),
      form: summaryToForm(f),
      suggestion:
        f.suggestedFolderId && ctx.writable.has(f.suggestedFolderId)
          ? { folderId: f.suggestedFolderId, path: ctx.paths.get(f.suggestedFolderId) ?? "", confidence: f.filingConfidence ?? 0, reason: f.filingReason ?? "" }
          : null,
    };
  });
  const focused = files.find((f) => f.id === focusId);
  const ordered = focused ? [focused, ...files.filter((f) => f !== focused)] : files;

  return (
    <div className="grid max-w-4xl gap-4">
      <div>
        <h1 className="text-xl font-semibold">Review</h1>
        <p className="text-muted-foreground text-sm">
          Check each file&apos;s summary, then confirm where it goes. Nothing is filed until you do.
          {role === "admin" ? " You see everyone's." : " You see your own."}
        </p>
      </div>
      <ReadingWatch active={files.some((f) => f.step === "reading")} />
      {files.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">Nothing is waiting. Every file is filed.</p>
      ) : (
        <div className="grid gap-4">
          {ordered.map((f) => (
            <ReviewCard key={f.id} slug={slug} file={f} kinds={kinds} folders={folders} focused={f.id === focusId} />
          ))}
        </div>
      )}
    </div>
  );
}
