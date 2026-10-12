"use client";

import { AlertCircle, CheckCircle2, ClipboardList, FileUp, Loader2, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { confirmUploadAction, startUploadAction } from "@/app/c/[slug]/actions";
import { Button } from "@/components/ui/button";
import { formatBytes, isBlockedFile } from "@/lib/file-names";

/**
 * Uploads run in the browser: hash the file, ask the server for a one-time URL, PUT the bytes
 * straight to the bucket (never through a Vercel function), confirm, then wait while the AI reads
 * the file. When it is done the uploader is taken to Review to check the summary and the folder.
 */

type Phase = "queued" | "hashing" | "uploading" | "finishing" | "reading" | "filed" | "review" | "version" | "duplicate" | "failed";

type Item = {
  id: number;
  name: string;
  size: number;
  phase: Phase;
  progress: number;
  message?: string;
  fileId?: string;
  duplicate?: { id: string; name: string; folderPath: string | null };
  job: { file: File; versionOf: string | null; allowDuplicate: boolean };
};

type UploadOptions = { versionOf?: string | null };

type Uploads = {
  canUpload: boolean;
  /** Opens the file picker. */
  pick: () => void;
  uploadFiles: (files: File[], options?: UploadOptions) => void;
};

const UploadContext = createContext<Uploads | null>(null);

export function useUploads(): Uploads {
  const value = useContext(UploadContext);
  if (!value) throw new Error("useUploads must be used inside UploadProvider");
  return value;
}

const MAX_PARALLEL = 2;
const ACTIVE: Phase[] = ["hashing", "uploading", "finishing", "reading"];

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function putToBucket(url: string, file: File, contentType: string, onProgress: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Storage answered ${xhr.status}.`)));
    xhr.onerror = () =>
      reject(new Error("Could not reach file storage. Check your connection; if it keeps failing, the bucket's CORS rule may be missing."));
    xhr.send(file);
  });
}

type ReadResult = { status: "read" } | { status: "not_read"; reason: string } | { status: "busy" } | { error: string };

/** The server answers "busy" while another of the person's AI calls runs; ask again a few times. */
const BUSY_RETRIES = 8;
const BUSY_WAIT_MS = 8_000;

/** Waits while the server has the AI read the file. */
async function readWithAi(slug: string, fileId: string): Promise<ReadResult> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`/c/${slug}/files/${fileId}/analyze`, { method: "POST" });
    if (!response.ok && response.status !== 400) return { error: `The AI reading step failed (${response.status}). You can write the summary yourself in Review.` };
    const result = (await response.json()) as ReadResult;
    if (!("status" in result) || result.status !== "busy" || attempt >= BUSY_RETRIES) return result;
    await new Promise((resolve) => setTimeout(resolve, BUSY_WAIT_MS));
  }
}

export function UploadProvider({
  slug,
  canUpload,
  oneAtATime,
  maxMb,
  children,
}: {
  slug: string;
  canUpload: boolean;
  /** Everyone but admins uploads one file at a time. */
  oneAtATime: boolean;
  maxMb: number;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);
  const started = useRef(new Set<number>());
  const reviewPath = `/c/${slug}/review`;

  const update = useCallback((id: number, patch: Partial<Item>) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }, []);

  const run = useCallback(
    async (item: Item) => {
      const { file, versionOf, allowDuplicate } = item.job;
      const fail = (message: string) => update(item.id, { phase: "failed", message });
      try {
        update(item.id, { phase: "hashing", progress: 0, message: undefined });
        const sha256 = await sha256Hex(file);
        const started = await startUploadAction(slug, { name: file.name, size: file.size, mimeType: file.type, sha256, fileId: versionOf, allowDuplicate });
        if (!started.ok) return fail(started.error);
        if (started.data.kind === "duplicate") {
          return update(item.id, { phase: "duplicate", duplicate: started.data.existing });
        }

        const { fileId, versionNo, uploadUrl, contentType } = started.data;
        update(item.id, { phase: "uploading", progress: 0 });
        await putToBucket(uploadUrl, file, contentType, (progress) => update(item.id, { progress }));

        update(item.id, { phase: "finishing", progress: 1 });
        const done = await confirmUploadAction(slug, { fileId, versionNo });
        if (!done.ok) return fail(done.error);
        const result = done.data;
        if (versionOf) {
          update(item.id, { fileId: result.fileId, phase: "version", message: `Version ${result.versionNo} added` });
          router.refresh();
          return;
        }
        if (result.status === "ready") {
          update(item.id, { fileId: result.fileId, phase: "filed", message: `Filed in ${result.folderPath ?? "a folder"}` });
          router.refresh();
          return;
        }

        update(item.id, { fileId: result.fileId, phase: "reading", message: "The AI is reading the file…" });
        const read = await readWithAi(slug, result.fileId);
        const message =
          "error" in read
            ? read.error
            : read.status === "read"
              ? "Summary ready to check"
              : read.status === "busy"
                ? "Still being read"
                : `The AI did not read it: ${read.reason}`;
        update(item.id, { phase: "review", message });
        // Take the uploader straight to the summary.
        if (pathname === reviewPath) router.refresh();
        else router.push(`${reviewPath}?file=${result.fileId}`);
      } catch (error) {
        fail(error instanceof Error ? error.message : "The upload failed. Please try again.");
      }
    },
    [pathname, reviewPath, router, slug, update],
  );

  // Start queued items, at most MAX_PARALLEL at a time.
  useEffect(() => {
    let free = MAX_PARALLEL - items.filter((i) => ACTIVE.includes(i.phase)).length;
    for (const item of items) {
      if (free <= 0) break;
      if (item.phase === "queued" && !started.current.has(item.id)) {
        started.current.add(item.id);
        free -= 1;
        void run(item);
      }
    }
  }, [items, run]);

  const uploadFiles = useCallback(
    (list: File[], options: UploadOptions = {}) => {
      if (!canUpload) return;
      const versionOf = options.versionOf ?? null;
      setItems((prev) => {
        const busy = prev.some((i) => i.phase === "queued" || ACTIVE.includes(i.phase));
        const added: Item[] = list.map((file, index) => {
          const id = nextId.current++;
          const problem = isBlockedFile(file.name, file.type)
            ? `${file.name} is an executable or script, so it cannot be stored.`
            : file.size === 0
              ? "The file is empty (folders cannot be uploaded)."
              : file.size > maxMb * 1024 * 1024
                ? `Larger than the ${maxMb} MB limit.`
                : oneAtATime && !versionOf && busy
                  ? "Finish the file in progress first, then upload the next one."
                  : oneAtATime && !versionOf && index > 0
                    ? "Upload one file at a time. Only admins can upload several at once."
                    : null;
          return {
            id,
            name: file.name,
            size: file.size,
            phase: problem ? "failed" : "queued",
            progress: 0,
            message: problem ?? undefined,
            job: { file, versionOf, allowDuplicate: false },
          };
        });
        for (const item of added) if (item.phase === "failed") started.current.add(item.id);
        return [...prev, ...added];
      });
    },
    [canUpload, maxMb, oneAtATime],
  );

  const retry = (item: Item, allowDuplicate = false) => {
    started.current.delete(item.id);
    setItems((prev) =>
      prev.map((i) => (i.id === item.id ? { ...i, phase: "queued", message: undefined, duplicate: undefined, job: { ...i.job, allowDuplicate } } : i)),
    );
  };

  // Drop files anywhere on the page.
  useEffect(() => {
    if (!canUpload) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth += 1;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      uploadFiles(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [canUpload, uploadFiles]);

  // Warn before leaving while files are still going up or being read.
  const busy = items.some((i) => i.phase === "queued" || ACTIVE.includes(i.phase));
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  const value = useMemo<Uploads>(() => ({ canUpload, pick: () => picker.current?.click(), uploadFiles }), [canUpload, uploadFiles]);

  return (
    <UploadContext.Provider value={value}>
      {children}
      {canUpload && (
        <input
          ref={picker}
          type="file"
          multiple={!oneAtATime}
          className="hidden"
          onChange={(e) => {
            uploadFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      )}
      {dragging && (
        <div className="bg-background/80 pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-6 backdrop-blur-sm">
          <div className="border-brand flex h-full w-full items-center justify-center rounded-2xl border-4 border-dashed text-xl font-medium">
            <FileUp className="mr-3 size-7" />
            {oneAtATime ? "Drop a file to upload" : "Drop files to upload"}
          </div>
        </div>
      )}
      {items.length > 0 && (
        <div role="status" className="bg-card fixed right-4 bottom-4 z-40 w-96 max-w-[calc(100vw-2rem)] rounded-xl border shadow-lg">
          <div className="flex items-center justify-between border-b px-4 py-2 text-sm font-medium">
            Uploads
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Clear finished uploads"
              onClick={() => setItems((prev) => prev.filter((i) => i.phase === "queued" || ACTIVE.includes(i.phase)))}
            >
              <X />
            </Button>
          </div>
          <ul className="max-h-80 divide-y overflow-y-auto">
            {items.map((item) => (
              <UploadRow
                key={item.id}
                item={item}
                slug={slug}
                onRetry={() => retry(item)}
                onUploadAnyway={() => retry(item, true)}
                onDismiss={() => setItems((prev) => prev.filter((i) => i.id !== item.id))}
              />
            ))}
          </ul>
        </div>
      )}
    </UploadContext.Provider>
  );
}

function UploadRow({
  item,
  slug,
  onRetry,
  onUploadAnyway,
  onDismiss,
}: {
  item: Item;
  slug: string;
  onRetry: () => void;
  onUploadAnyway: () => void;
  onDismiss: () => void;
}) {
  const working = item.phase === "hashing" || item.phase === "uploading" || item.phase === "finishing";
  return (
    <li className="grid gap-1 px-4 py-2.5 text-sm">
      <div className="flex items-center gap-2">
        {working || item.phase === "queued" ? (
          <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" />
        ) : item.phase === "reading" ? (
          <Sparkles className="text-brand size-4 shrink-0 animate-pulse" />
        ) : item.phase === "failed" ? (
          <AlertCircle className="text-destructive size-4 shrink-0" />
        ) : item.phase === "review" || item.phase === "duplicate" ? (
          <ClipboardList className="size-4 shrink-0 text-amber-600" />
        ) : (
          <CheckCircle2 className="size-4 shrink-0 text-green-600" />
        )}
        <span dir="auto" className="min-w-0 flex-1 truncate font-medium" title={item.name}>
          {item.name}
        </span>
        <span className="text-muted-foreground shrink-0 text-xs">{formatBytes(item.size)}</span>
      </div>

      {working && (
        <div className="grid gap-1">
          <div className="bg-muted h-1.5 overflow-hidden rounded-full">
            <div className="bg-brand h-full transition-all" style={{ width: `${Math.round(item.progress * 100)}%` }} />
          </div>
          <span className="text-muted-foreground text-xs">
            {item.phase === "hashing" ? "Checking the file…" : item.phase === "uploading" ? `Uploading ${Math.round(item.progress * 100)}%` : "Saving…"}
          </span>
        </div>
      )}
      {item.phase === "queued" && <span className="text-muted-foreground text-xs">Waiting…</span>}
      {item.phase === "reading" && <span className="text-muted-foreground text-xs">{item.message} This usually takes 5–30 seconds.</span>}

      {(item.phase === "filed" || item.phase === "review" || item.phase === "version") && (
        <div className="flex items-center justify-between gap-2 text-xs">
          <span dir="auto" className="text-muted-foreground">
            {item.message}
          </span>
          {item.fileId && (
            <Link href={item.phase === "review" ? `/c/${slug}/review?file=${item.fileId}` : `/c/${slug}/files/${item.fileId}`} className="shrink-0 underline">
              {item.phase === "review" ? "Check it" : "Open"}
            </Link>
          )}
        </div>
      )}

      {item.phase === "duplicate" && item.duplicate && (
        <div className="grid gap-1.5 text-xs">
          <span dir="auto" className="text-muted-foreground">
            The same file is already here as “{item.duplicate.name}”{item.duplicate.folderPath ? ` in ${item.duplicate.folderPath}` : " (not filed yet)"}.
          </span>
          <div className="flex gap-2">
            <Button asChild size="sm" variant="outline">
              <Link href={`/c/${slug}/files/${item.duplicate.id}`}>Open existing</Link>
            </Button>
            <Button size="sm" variant="ghost" onClick={onUploadAnyway}>
              Upload anyway
            </Button>
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              Skip
            </Button>
          </div>
        </div>
      )}

      {item.phase === "failed" && (
        <div className="flex items-start justify-between gap-2 text-xs">
          <span dir="auto" className="text-destructive">
            {item.message}
          </span>
          <span className="flex shrink-0 gap-1">
            {item.job.file.size > 0 && !isBlockedFile(item.name, item.job.file.type) && item.job.file.size <= 1024 * 1024 * 1024 && (
              <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={onRetry}>
                Retry
              </Button>
            )}
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onDismiss}>
              Dismiss
            </Button>
          </span>
        </div>
      )}
    </li>
  );
}
