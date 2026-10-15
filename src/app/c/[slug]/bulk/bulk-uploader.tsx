"use client";

import { AlertCircle, CheckCircle2, ClipboardList, Download, FolderUp, Loader2, Sparkles, Upload } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { confirmUploadAction, startUploadAction } from "@/app/c/[slug]/actions";
import { putToBucket, sha256Hex } from "@/components/upload-provider";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AutoFileResult } from "@/app/c/[slug]/files/[id]/auto-file/route";
import { formatBytes, isBlockedFile } from "@/lib/file-names";

/**
 * Two lanes: files are hashed and uploaded two at a time, then handed one at a time to the AI
 * (the server reads one file per person at a time). Each file ends filed, left for Review,
 * skipped as a duplicate, or failed; the table is the report, and it can be downloaded as CSV.
 */

type Phase = "queued" | "hashing" | "uploading" | "finishing" | "waiting" | "reading" | "filed" | "review" | "duplicate" | "skipped" | "failed";

type Item = {
  id: number;
  file: File;
  name: string;
  relPath: string;
  size: number;
  phase: Phase;
  progress: number;
  fileId?: string;
  /** Where it was filed, the reason it waits in Review, or what went wrong. */
  detail?: string;
  newParty?: string | null;
  confidence?: number;
};

const UPLOAD_LANES = 2;
const BUSY_WAIT_MS = 8_000;
const BUSY_RETRIES = 30;
const DONE: Phase[] = ["filed", "review", "duplicate", "skipped", "failed"];
const SYSTEM_FILES = /^(\.DS_Store|Thumbs\.db|desktop\.ini|~\$.*|\._.*)$/;

async function readAndFile(slug: string, fileId: string): Promise<AutoFileResult> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`/c/${slug}/files/${fileId}/auto-file`, { method: "POST" });
    if (!response.ok && response.status !== 400) return { error: `The AI step failed (${response.status}); the file waits in Review.` };
    const result = (await response.json()) as AutoFileResult;
    if (!("status" in result) || result.status !== "busy" || attempt >= BUSY_RETRIES) return result;
    await new Promise((resolve) => setTimeout(resolve, BUSY_WAIT_MS));
  }
}

function csvOf(items: Item[]): string {
  const cell = (v: string | number | undefined | null) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const rows = items.map((i) => [i.relPath, i.size, i.phase, i.detail, i.newParty ?? "", i.confidence === undefined ? "" : Math.round(i.confidence * 100), i.fileId ?? ""]);
  return ["file,bytes,result,detail,new company,confidence %,id", ...rows.map((r) => r.map(cell).join(","))].join("\n");
}

export function BulkUploader({ slug, maxMb, aiAvailable }: { slug: string; maxMb: number; aiAvailable: boolean }) {
  const [items, setItems] = useState<Item[]>([]);
  const [running, setRunning] = useState(false);
  const nextId = useRef(1);
  const folderInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);

  const update = (id: number, patch: Partial<Item>) => setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  const add = (files: FileList | null) => {
    if (!files) return;
    const added: Item[] = [];
    for (const file of Array.from(files)) {
      const relPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      if (SYSTEM_FILES.test(file.name)) continue;
      const problem =
        file.size === 0 ? "Empty file" : isBlockedFile(file.name, file.type) ? "This kind of file is not accepted" : file.size > maxMb * 1024 * 1024 ? `Larger than ${maxMb} MB` : null;
      added.push({ id: nextId.current++, file, name: file.name, relPath, size: file.size, phase: problem ? "skipped" : "queued", progress: 0, detail: problem ?? undefined });
    }
    setItems((prev) => [...prev, ...added]);
  };

  // Leaving the page would abandon what is still queued.
  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  const start = async () => {
    setRunning(true);
    const queue = items.filter((i) => i.phase === "queued");
    const forAi: Item[] = [];
    let aiRunning = false;

    const aiLane = async () => {
      if (aiRunning) return;
      aiRunning = true;
      while (forAi.length) {
        const item = forAi.shift()!;
        update(item.id, { phase: "reading" });
        const result = await readAndFile(slug, item.fileId!);
        if ("error" in result) update(item.id, { phase: "review", detail: result.error });
        else if (result.status === "busy") update(item.id, { phase: "review", detail: "The AI was busy for too long; check it in Review." });
        else if (result.outcome.action === "filed") {
          update(item.id, { phase: "filed", detail: result.outcome.path, newParty: result.outcome.newParty, confidence: result.outcome.confidence });
        } else update(item.id, { phase: "review", detail: result.outcome.reason });
      }
      aiRunning = false;
    };

    const uploadOne = async (item: Item) => {
      try {
        update(item.id, { phase: "hashing" });
        const sha256 = await sha256Hex(item.file);
        const started = await startUploadAction(slug, { name: item.name, size: item.size, mimeType: item.file.type, sha256, allowDuplicate: false });
        if (!started.ok) return update(item.id, { phase: "failed", detail: started.error });
        if (started.data.kind === "duplicate") {
          const { existing } = started.data;
          return update(item.id, { phase: "duplicate", fileId: existing.id, detail: `Already here as “${existing.name}”${existing.folderPath ? ` in ${existing.folderPath}` : ""}` });
        }
        const { fileId, versionNo, uploadUrl, contentType } = started.data;
        update(item.id, { phase: "uploading" });
        await putToBucket(uploadUrl, item.file, contentType, (progress) => update(item.id, { progress }));
        update(item.id, { phase: "finishing", progress: 1 });
        const done = await confirmUploadAction(slug, { fileId, versionNo });
        if (!done.ok) return update(item.id, { phase: "failed", detail: done.error });
        update(item.id, { phase: "waiting", fileId: done.data.fileId });
        forAi.push({ ...item, fileId: done.data.fileId });
        void aiLane();
      } catch (error) {
        update(item.id, { phase: "failed", detail: error instanceof Error ? error.message : "The upload failed." });
      }
    };

    // UPLOAD_LANES workers over the queue; the AI lane drains behind them.
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) await uploadOne(queue[cursor++]!);
    };
    await Promise.all(Array.from({ length: UPLOAD_LANES }, worker));
    // Wait for the AI lane to finish what the uploads handed over.
    while (aiRunning || forAi.length) await new Promise((resolve) => setTimeout(resolve, 500));
    setRunning(false);
  };

  const count = (phase: Phase) => items.filter((i) => i.phase === phase).length;
  const queued = count("queued");
  const finished = items.length > 0 && !running && items.every((i) => DONE.includes(i.phase));
  const newParties = [...new Set(items.flatMap((i) => (i.newParty ? [i.newParty] : [])))];

  const download = () => {
    const blob = new Blob([`﻿${csvOf(items)}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: `bulk-upload-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="grid gap-4">
      <input ref={folderInput} type="file" className="hidden" multiple {...({ webkitdirectory: "" } as object)} onChange={(e) => (add(e.target.files), (e.target.value = ""))} />
      <input ref={filesInput} type="file" className="hidden" multiple onChange={(e) => (add(e.target.files), (e.target.value = ""))} />

      {!aiAvailable && (
        <p role="alert" className="text-destructive text-sm">
          The AI is not set up on this server, so nothing can be filed automatically. Files would all wait in Review.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => folderInput.current?.click()} disabled={running}>
          <FolderUp />
          Choose a folder
        </Button>
        <Button variant="outline" onClick={() => filesInput.current?.click()} disabled={running}>
          <Upload />
          Choose files
        </Button>
        <Button onClick={start} disabled={running || queued === 0 || !aiAvailable}>
          {running ? <Loader2 className="animate-spin" /> : <Sparkles />}
          {running ? "Working…" : queued ? `Upload and file ${queued} ${queued === 1 ? "file" : "files"}` : "Upload and file"}
        </Button>
        {items.length > 0 && !running && (
          <Button variant="ghost" onClick={() => setItems([])}>
            Clear
          </Button>
        )}
      </div>

      {items.length > 0 && (
        <div className="bg-card grid gap-3 rounded-xl border p-4 text-sm">
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            <span>
              <strong>{count("filed")}</strong> filed
            </span>
            <span>
              <strong>{count("review")}</strong> for review
            </span>
            <span>
              <strong>{count("duplicate")}</strong> duplicates
            </span>
            <span>
              <strong>{count("skipped") + count("failed")}</strong> skipped or failed
            </span>
            <span className="text-muted-foreground">
              {items.length - items.filter((i) => DONE.includes(i.phase)).length} to go of {items.length}
            </span>
          </div>
          {finished && (
            <div className="flex flex-wrap items-center gap-3 border-t pt-3">
              <span className="font-medium">Done.</span>
              {newParties.length > 0 && (
                <span dir="auto" className="text-muted-foreground">
                  New customers or suppliers: {newParties.join(", ")}
                </span>
              )}
              {count("review") > 0 && (
                <Link href={`/c/${slug}/review`} className="underline">
                  Open Review ({count("review")})
                </Link>
              )}
              <Button variant="outline" size="sm" onClick={download}>
                <Download />
                Download report (CSV)
              </Button>
            </div>
          )}
        </div>
      )}

      {items.length > 0 && (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead className="w-36">Result</TableHead>
                <TableHead className="hidden md:table-cell">Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="max-w-md whitespace-normal">
                    <span dir="auto" className="block truncate font-medium" title={item.relPath}>
                      {item.relPath}
                    </span>
                    <span className="text-muted-foreground block truncate text-xs md:hidden">{item.detail}</span>
                  </TableCell>
                  <TableCell>
                    <Status item={item} />
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden max-w-lg whitespace-normal md:table-cell">
                    {item.fileId && (item.phase === "filed" || item.phase === "review" || item.phase === "duplicate") ? (
                      <Link href={item.phase === "review" ? `/c/${slug}/review?file=${item.fileId}` : `/c/${slug}/files/${item.fileId}`} dir="auto" className="hover:underline">
                        {item.detail}
                      </Link>
                    ) : (
                      <span dir="auto">{item.detail}</span>
                    )}
                    {item.newParty && <span className="ml-1 text-xs">(new: {item.newParty})</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {items.length === 0 && (
        <p className="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
          Choose a folder (all its files, subfolders included) or a set of files. Nothing is sent until you press Upload and file. {formatBytes(maxMb * 1024 * 1024)} per
          file at most.
        </p>
      )}
    </div>
  );
}

function Status({ item }: { item: Item }) {
  const label: Record<Phase, string> = {
    queued: "Waiting",
    hashing: "Checking…",
    uploading: `Uploading ${Math.round(item.progress * 100)}%`,
    finishing: "Saving…",
    waiting: "Waiting for the AI",
    reading: "AI reading…",
    filed: "Filed",
    review: "For review",
    duplicate: "Duplicate",
    skipped: "Skipped",
    failed: "Failed",
  };
  const icon =
    item.phase === "filed" ? (
      <CheckCircle2 className="size-4 text-green-600" />
    ) : item.phase === "review" || item.phase === "duplicate" ? (
      <ClipboardList className="size-4 text-amber-600" />
    ) : item.phase === "failed" || item.phase === "skipped" ? (
      <AlertCircle className="text-destructive size-4" />
    ) : item.phase === "reading" ? (
      <Sparkles className="text-brand size-4 animate-pulse" />
    ) : item.phase === "queued" ? null : (
      <Loader2 className="text-muted-foreground size-4 animate-spin" />
    );
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      {icon}
      {label[item.phase]}
    </span>
  );
}
