"use client";

import { AlertCircle, CheckCircle2, ClipboardList, FileUp, Loader2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { confirmUploadAction, startUploadAction } from "@/app/c/[slug]/actions";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import type { DocType } from "@/lib/doc-types";
import type { FileKind } from "@/lib/file-kinds";
import { formatBytes, isBlockedFile } from "@/lib/file-names";

/**
 * Uploads run in the browser. First the uploader says what each file is, which picks its folder
 * and type. Then: hash the file, ask the server for a one-time URL, PUT the bytes straight to the
 * bucket (never through a Vercel function), and confirm. Several files can run at once.
 */

type Phase = "asking" | "queued" | "hashing" | "uploading" | "finishing" | "filed" | "review" | "version" | "duplicate" | "failed";

type Item = {
  id: number;
  name: string;
  size: number;
  phase: Phase;
  progress: number;
  message?: string;
  fileId?: string;
  duplicate?: { id: string; name: string; folderPath: string | null };
  job: { file: File; folderId: string | null; docType: DocType | null; versionOf: string | null; allowDuplicate: boolean };
};

/** An answer to "What is this file?": `kind:<id>`, `folder:<id>` (empty id while choosing), or `review`. */
type Answer = string;

/** A folder the person can upload to, with its full path. */
type UploadFolder = { id: string; path: string };

type UploadOptions = { folderId?: string | null; versionOf?: string | null };

type Uploads = {
  canUpload: boolean;
  /** Opens the file picker; each file is then asked what it is, which decides its folder. */
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
const ACTIVE: Phase[] = ["hashing", "uploading", "finishing"];

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

export function UploadProvider({
  slug,
  canUpload,
  maxMb,
  kinds,
  folders,
  children,
}: {
  slug: string;
  canUpload: boolean;
  maxMb: number;
  /** The answers to "What is this file?" this person can use. */
  kinds: FileKind[];
  folders: UploadFolder[];
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>([]);
  const [answers, setAnswers] = useState<Record<number, Answer>>({});
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);
  const started = useRef(new Set<number>());

  const update = useCallback((id: number, patch: Partial<Item>) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }, []);

  const run = useCallback(
    async (item: Item) => {
      const { file, folderId, docType, versionOf, allowDuplicate } = item.job;
      const fail = (message: string) => update(item.id, { phase: "failed", message });
      try {
        update(item.id, { phase: "hashing", progress: 0, message: undefined });
        const sha256 = await sha256Hex(file);
        const started = await startUploadAction(slug, {
          name: file.name,
          size: file.size,
          mimeType: file.type,
          sha256,
          folderId,
          docType,
          fileId: versionOf,
          allowDuplicate,
        });
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
        update(item.id, {
          fileId: result.fileId,
          phase: versionOf ? "version" : result.status === "ready" ? "filed" : "review",
          message: versionOf ? `Version ${result.versionNo} added` : result.folderPath ? `Filed in ${result.folderPath}` : "Needs a folder",
        });
        router.refresh();
      } catch (error) {
        fail(error instanceof Error ? error.message : "The upload failed. Please try again.");
      }
    },
    [router, slug, update],
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
      // The folder open on the Files page is the suggested answer.
      const here = new URL(window.location.href);
      const folderId = options.folderId !== undefined ? options.folderId : here.pathname === `/c/${slug}` ? here.searchParams.get("folder") : null;
      const versionOf = options.versionOf ?? null;
      const added: Item[] = list.map((file) => {
        const id = nextId.current++;
        const problem = isBlockedFile(file.name, file.type)
          ? `${file.name} is an executable or script, so it cannot be stored.`
          : file.size === 0
            ? "The file is empty (folders cannot be uploaded)."
            : file.size > maxMb * 1024 * 1024
              ? `Larger than the ${maxMb} MB limit.`
              : null;
        return {
          id,
          name: file.name,
          size: file.size,
          // A new version keeps its file's folder; a new file is asked what it is first.
          phase: problem ? "failed" : versionOf ? "queued" : "asking",
          progress: 0,
          message: problem ?? undefined,
          job: { file, folderId: folderId ?? null, docType: null, versionOf, allowDuplicate: false },
        };
      });
      for (const item of added) if (item.phase === "failed") started.current.add(item.id);
      const suggested = suggestAnswer(kinds, folders, folderId ?? null);
      setAnswers((prev) => ({ ...prev, ...Object.fromEntries(added.filter((i) => i.phase === "asking").map((i) => [i.id, suggested])) }));
      setItems((prev) => [...prev, ...added]);
    },
    [canUpload, maxMb, slug, kinds, folders],
  );

  const asking = items.filter((i) => i.phase === "asking");

  /** Applies each answer and starts the uploads. */
  const startAsked = () => {
    setItems((prev) =>
      prev.map((i) => {
        if (i.phase !== "asking") return i;
        const target = resolveAnswer(kinds, answers[i.id] ?? "");
        return target ? { ...i, phase: "queued", job: { ...i.job, ...target } } : i;
      }),
    );
  };
  const cancelAsked = () => setItems((prev) => prev.filter((i) => i.phase !== "asking"));

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

  // Warn before leaving while files are still going up.
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
          multiple
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
            Drop files to upload
          </div>
        </div>
      )}
      {asking.length > 0 && (
        <AskDialog
          items={asking}
          kinds={kinds}
          folders={folders}
          answers={answers}
          onAnswer={(id, answer) => setAnswers((prev) => ({ ...prev, [id]: answer }))}
          onUpload={startAsked}
          onCancel={cancelAsked}
        />
      )}
      {items.some((i) => i.phase !== "asking") && (
        <div role="status" className="bg-card fixed right-4 bottom-4 z-40 w-96 max-w-[calc(100vw-2rem)] rounded-xl border shadow-lg">
          <div className="flex items-center justify-between border-b px-4 py-2 text-sm font-medium">
            Uploads
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Clear finished uploads"
              onClick={() => setItems((prev) => prev.filter((i) => i.phase === "asking" || i.phase === "queued" || ACTIVE.includes(i.phase)))}
            >
              <X />
            </Button>
          </div>
          <ul className="max-h-80 divide-y overflow-y-auto">
            {items
              .filter((i) => i.phase !== "asking")
              .map((item) => (
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
            {item.phase === "hashing" ? "Checking the file…" : item.phase === "uploading" ? `Uploading ${Math.round(item.progress * 100)}%` : "Filing…"}
          </span>
        </div>
      )}
      {item.phase === "queued" && <span className="text-muted-foreground text-xs">Waiting…</span>}

      {(item.phase === "filed" || item.phase === "review" || item.phase === "version") && (
        <div className="flex items-center justify-between gap-2 text-xs">
          <span dir="auto" className="text-muted-foreground">
            {item.message}
            {item.phase === "review" && (
              <>
                {" · "}
                <Link href={`/c/${slug}/review`} className="underline">
                  choose one in Review
                </Link>
              </>
            )}
          </span>
          {item.fileId && (
            <Link href={`/c/${slug}/files/${item.fileId}`} className="shrink-0 underline">
              Open
            </Link>
          )}
        </div>
      )}

      {item.phase === "duplicate" && item.duplicate && (
        <div className="grid gap-1.5 text-xs">
          <span dir="auto" className="text-muted-foreground">
            The same file is already here as “{item.duplicate.name}”{item.duplicate.folderPath ? ` in ${item.duplicate.folderPath}` : " (unfiled)"}.
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

/** The answer that matches the folder open when the files were added, if any. */
function suggestAnswer(kinds: FileKind[], folders: UploadFolder[], folderId: string | null): Answer {
  if (!folderId) return "";
  const kind = kinds.find((k) => k.folderId === folderId);
  if (kind) return `kind:${kind.id}`;
  return folders.some((f) => f.id === folderId) ? `folder:${folderId}` : "";
}

/** Where an answer files the upload, or null while it is incomplete. */
function resolveAnswer(kinds: FileKind[], answer: Answer): { folderId: string | null; docType: DocType | null } | null {
  if (answer === "review") return { folderId: null, docType: null };
  if (answer.startsWith("kind:")) {
    const kind = kinds.find((k) => k.id === answer.slice(5));
    return kind ? { folderId: kind.folderId, docType: kind.docType } : null;
  }
  if (answer.startsWith("folder:") && answer.length > 7) return { folderId: answer.slice(7), docType: null };
  return null;
}

function AskDialog({
  items,
  kinds,
  folders,
  answers,
  onAnswer,
  onUpload,
  onCancel,
}: {
  items: Item[];
  kinds: FileKind[];
  folders: UploadFolder[];
  answers: Record<number, Answer>;
  onAnswer: (id: number, answer: Answer) => void;
  onUpload: () => void;
  onCancel: () => void;
}) {
  const groups = [...new Set(kinds.map((k) => k.group))];
  const ready = items.every((i) => resolveAnswer(kinds, answers[i.id] ?? "") !== null);
  const first = answers[items[0]!.id] ?? "";

  useEffect(() => {
    const close = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onCancel]);

  return (
    <div className="bg-background/80 fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="ask-title"
        className="bg-card grid max-h-[calc(100dvh-2rem)] w-full max-w-xl grid-rows-[auto_1fr_auto] rounded-xl border shadow-lg"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) onUpload();
        }}
      >
        <div className="border-b px-5 py-4">
          <h2 id="ask-title" className="font-semibold">
            {items.length === 1 ? "What is this file?" : `What are these ${items.length} files?`}
          </h2>
          <p className="text-muted-foreground text-sm">
            {items.length === 1 ? "Your answer decides which folder it is saved in." : "Your answers decide which folder each one is saved in."}
          </p>
        </div>

        <ul className="divide-y overflow-y-auto">
          {items.map((item, index) => {
            const answer = answers[item.id] ?? "";
            const choosingFolder = answer.startsWith("folder:");
            return (
              <li key={item.id} className="grid gap-2 px-5 py-3">
                <div className="flex items-center gap-2 text-sm">
                  <span dir="auto" className="min-w-0 flex-1 truncate font-medium" title={item.name}>
                    {item.name}
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs">{formatBytes(item.size)}</span>
                </div>
                <NativeSelect
                  aria-label={`What is ${item.name}?`}
                  autoFocus={index === 0}
                  value={choosingFolder ? "folder:" : answer}
                  onChange={(e) => onAnswer(item.id, e.target.value)}
                  className="w-full"
                >
                  <option value="" disabled>
                    Choose what it is…
                  </option>
                  {groups.map((group) => (
                    <optgroup key={group} label={group}>
                      {kinds
                        .filter((k) => k.group === group)
                        .map((k) => (
                          <option key={k.id} value={`kind:${k.id}`}>
                            {k.label}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                  <optgroup label="Not listed">
                    {folders.length > 0 && <option value="folder:">Choose a folder myself…</option>}
                    <option value="review">Not sure — leave it in Review</option>
                  </optgroup>
                </NativeSelect>
                {choosingFolder && (
                  <NativeSelect
                    aria-label={`Folder for ${item.name}`}
                    value={answer.slice(7)}
                    onChange={(e) => onAnswer(item.id, `folder:${e.target.value}`)}
                    className="w-full"
                  >
                    <option value="" disabled>
                      Choose a folder…
                    </option>
                    {folders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.path}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </li>
            );
          })}
        </ul>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-5 py-3">
          {items.length > 1 && resolveAnswer(kinds, first) ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => items.forEach((i) => onAnswer(i.id, first))}>
              Use the first answer for all
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready}>
              {items.length === 1 ? "Upload" : `Upload ${items.length} files`}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
