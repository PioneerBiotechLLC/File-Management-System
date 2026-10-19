"use client";

import { AlertCircle, Download, FolderUp, Loader2, RotateCcw, Upload } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { confirmUploadAction } from "@/app/c/[slug]/actions";
import { putToBucket, sha256Hex } from "@/components/upload-provider";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBytes, isBlockedFile } from "@/lib/file-names";
import { folderOf, foldersNeeded } from "@/lib/project-paths";
import { ensureProjectFoldersAction, startProjectUploadAction } from "./actions";

/**
 * A project folder from the computer, uploaded as it is: its folders are created first (parents
 * before children), then its files go up four at a time straight into them, with no AI step.
 * Tens of thousands of files are normal here, so the list lives outside React state and the page
 * redraws a few times a second; the table shows only what needs attention, the CSV has everything.
 */

type Phase = "queued" | "hashing" | "uploading" | "finishing" | "done" | "present" | "skipped" | "failed";

type Item = { id: number; file: File; relPath: string; folder: string; size: number; phase: Phase; progress: number; detail?: string; fileId?: string };

const LANES = 4;
const FOLDER_BATCH = 400;
const TABLE_ROWS = 300;
const SYSTEM_FILES = /^(\.DS_Store|Thumbs\.db|desktop\.ini|~\$.*|\._.*)$/;
const FINISHED: Phase[] = ["done", "present", "skipped", "failed"];
const ACTIVE: Phase[] = ["hashing", "uploading", "finishing"];

function csvOf(items: Item[]): string {
  const cell = (v: string | number | undefined) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  return ["file,bytes,result,detail,id", ...items.map((i) => [i.relPath, i.size, i.phase, i.detail, i.fileId].map(cell).join(","))].join("\n");
}

export function ProjectUploader({ slug, maxMb, targets, rootPath }: { slug: string; maxMb: number; targets: { id: string; path: string }[]; rootPath: string }) {
  const items = useRef<Item[]>([]);
  const [, setVersion] = useState(0);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [parentId, setParentId] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Redraw at most every 250 ms, however many files change.
  const redraw = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setVersion((v) => v + 1);
    }, 250);
  }, []);
  const set = useCallback((item: Item, patch: Partial<Item>) => (Object.assign(item, patch), redraw()), [redraw]);

  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  const choose = (files: File[]) => {
    let next = items.current.length ? Math.max(...items.current.map((i) => i.id)) + 1 : 1;
    const added: Item[] = [];
    for (const file of files) {
      if (SYSTEM_FILES.test(file.name)) continue;
      const relPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const problem = file.size === 0 ? "Empty file" : isBlockedFile(file.name, file.type) ? "Executables and scripts cannot be stored" : file.size > maxMb * 1024 * 1024 ? `Larger than ${maxMb} MB` : null;
      added.push({ id: next++, file, relPath, folder: folderOf(relPath), size: file.size, phase: problem ? "skipped" : "queued", progress: 0, detail: problem ?? undefined });
    }
    items.current = [...items.current, ...added];
    setError(null);
    redraw();
  };

  const uploadOne = async (item: Item, folderId: string) => {
    try {
      set(item, { phase: "hashing", detail: undefined });
      const sha256 = await sha256Hex(item.file);
      const started = await startProjectUploadAction(slug, { name: item.file.name, size: item.size, mimeType: item.file.type, sha256, folderId });
      if (!started.ok) return set(item, { phase: "failed", detail: started.error });
      if (started.data.kind === "duplicate") return set(item, { phase: "present", fileId: started.data.existing.id, detail: "Already in this folder" });
      const { fileId, versionNo, uploadUrl, contentType } = started.data;
      set(item, { phase: "uploading" });
      await putToBucket(uploadUrl, item.file, contentType, (progress) => set(item, { progress }));
      set(item, { phase: "finishing", progress: 1 });
      const done = await confirmUploadAction(slug, { fileId, versionNo });
      if (!done.ok) return set(item, { phase: "failed", detail: done.error });
      set(item, { phase: "done", fileId: done.data.fileId, detail: done.data.folderPath ?? undefined });
    } catch (e) {
      set(item, { phase: "failed", detail: e instanceof Error ? e.message : "The upload failed." });
    }
  };

  const start = async (only?: Item[]) => {
    const queue = only ?? items.current.filter((i) => i.phase === "queued");
    if (queue.length === 0) return;
    setRunning(true);
    setError(null);
    try {
      // 1. The folders, parents first, a batch at a time.
      const paths = foldersNeeded(queue.map((i) => i.relPath));
      const folderIds: Record<string, string> = {};
      for (let i = 0; i < paths.length; i += FOLDER_BATCH) {
        setStage(`Creating folders… ${Math.min(i + FOLDER_BATCH, paths.length)} of ${paths.length}`);
        const made = await ensureProjectFoldersAction(slug, { parentId: parentId || null, paths: paths.slice(i, i + FOLDER_BATCH) });
        if (!made.ok) throw new Error(made.error);
        Object.assign(folderIds, made.data);
      }
      setStage(null);

      // 2. The files, LANES at a time.
      let cursor = 0;
      const lane = async () => {
        while (cursor < queue.length) {
          const item = queue[cursor++]!;
          const folderId = item.folder ? folderIds[item.folder] : parentId;
          if (!folderId) {
            set(item, { phase: "failed", detail: "Its folder could not be created. Pick a folder rather than loose files." });
            continue;
          }
          await uploadOne(item, folderId);
        }
      };
      await Promise.all(Array.from({ length: LANES }, lane));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setStage(null);
      setRunning(false);
      redraw();
    }
  };

  const all = items.current;
  const count = (phase: Phase) => all.filter((i) => i.phase === phase).length;
  const failed = all.filter((i) => i.phase === "failed");
  const left = all.filter((i) => !FINISHED.includes(i.phase));
  const bytesTotal = all.filter((i) => i.phase !== "skipped").reduce((s, i) => s + i.size, 0);
  const bytesDone = all.reduce((s, i) => s + (i.phase === "done" || i.phase === "present" ? i.size : i.phase === "uploading" ? i.size * i.progress : 0), 0);
  const attention = [...all.filter((i) => ACTIVE.includes(i.phase)), ...failed, ...all.filter((i) => i.phase === "skipped")].slice(0, TABLE_ROWS);
  const top = [...new Set(all.map((i) => i.relPath.split("/")[0]))];

  const download = () => {
    const blob = new Blob([`﻿${csvOf(all)}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement("a"), { href: url, download: `project-upload-${new Date().toISOString().slice(0, 10)}.csv` }).click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="grid gap-4">
      <input ref={picker} type="file" className="hidden" multiple {...({ webkitdirectory: "" } as object)} onChange={(e) => (choose(Array.from(e.target.files ?? [])), (e.target.value = ""))} />

      <div className="bg-card grid gap-4 rounded-xl border p-4">
        <div className="grid max-w-xl gap-1.5">
          <Label htmlFor="project-parent">Upload into</Label>
          <NativeSelect id="project-parent" value={parentId} onChange={(e) => setParentId(e.target.value)} disabled={running}>
            <option value="">{rootPath} (as a new project)</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.path}
              </option>
            ))}
          </NativeSelect>
          <p className="text-muted-foreground text-xs">The folder you choose from your computer keeps its own name, inside this one.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => picker.current?.click()} disabled={running}>
            <FolderUp />
            Choose a folder
          </Button>
          <Button onClick={() => void start()} disabled={running || count("queued") === 0}>
            {running ? <Loader2 className="animate-spin" /> : <Upload />}
            {running ? "Uploading…" : `Upload ${count("queued").toLocaleString("en")} ${count("queued") === 1 ? "file" : "files"}`}
          </Button>
          {!running && failed.length > 0 && (
            <Button variant="outline" onClick={() => (failed.forEach((i) => Object.assign(i, { phase: "queued", progress: 0 })), void start(failed))}>
              <RotateCcw />
              Try the {failed.length.toLocaleString("en")} failed again
            </Button>
          )}
          {!running && all.length > 0 && (
            <Button variant="ghost" onClick={() => ((items.current = []), redraw())}>
              Clear
            </Button>
          )}
        </div>
        {error && (
          <p role="alert" className="text-destructive flex items-center gap-2 text-sm">
            <AlertCircle className="size-4" />
            {error}
          </p>
        )}
      </div>

      {all.length > 0 && (
        <div className="bg-card grid gap-3 rounded-xl border p-4 text-sm">
          <p dir="auto" className="text-muted-foreground">
            {top.length === 1 ? <>Folder “{top[0]}”</> : <>{top.length} folders</>} · {all.length.toLocaleString("en")} files · {formatBytes(bytesTotal)} ·{" "}
            {foldersNeeded(all.filter((i) => i.phase !== "skipped").map((i) => i.relPath)).length.toLocaleString("en")} folders inside
          </p>
          <div className="bg-muted h-2 overflow-hidden rounded-full">
            <div className="bg-brand h-full transition-[width]" style={{ width: `${bytesTotal ? Math.min(100, (bytesDone / bytesTotal) * 100) : 0}%` }} />
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            <span>
              <strong>{count("done").toLocaleString("en")}</strong> uploaded
            </span>
            <span>
              <strong>{count("present").toLocaleString("en")}</strong> already there
            </span>
            <span>
              <strong>{count("skipped").toLocaleString("en")}</strong> skipped
            </span>
            <span>
              <strong>{failed.length.toLocaleString("en")}</strong> failed
            </span>
            <span className="text-muted-foreground">{left.length.toLocaleString("en")} to go</span>
            {stage && <span className="text-muted-foreground">{stage}</span>}
          </div>
          {!running && left.length === 0 && (
            <div className="flex flex-wrap items-center gap-3 border-t pt-3">
              <span className="font-medium">Done.</span>
              <Link href={`/c/${slug}${parentId ? `?folder=${parentId}` : ""}`} className="underline">
                Open the files
              </Link>
              <Button variant="outline" size="sm" onClick={download}>
                <Download />
                Download report (CSV)
              </Button>
            </div>
          )}
        </div>
      )}

      {attention.length > 0 && (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead className="w-32">Status</TableHead>
                <TableHead className="hidden md:table-cell">Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {attention.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="max-w-md whitespace-normal">
                    <span dir="auto" className="block truncate" title={item.relPath}>
                      {item.relPath}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {item.phase === "uploading" ? `Uploading ${Math.round(item.progress * 100)}%` : { hashing: "Checking…", finishing: "Saving…", failed: "Failed", skipped: "Skipped" }[item.phase as string] ?? item.phase}
                  </TableCell>
                  <TableCell dir="auto" className="text-muted-foreground hidden max-w-lg whitespace-normal md:table-cell">
                    {item.detail}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {all.length === 0 && (
        <p className="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
          Choose a project folder. Nothing is sent until you press Upload. {formatBytes(maxMb * 1024 * 1024)} per file at most; executables and scripts are skipped.
        </p>
      )}
    </div>
  );
}
