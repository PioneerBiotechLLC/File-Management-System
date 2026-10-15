"use client";

import { Download, Loader2, Sparkles } from "lucide-react";
import { useRef, useState } from "react";
import type { RefileResult } from "@/app/c/[slug]/files/[id]/refile/route";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { REFILE_SCOPES, type RefileItem } from "@/lib/refile-scopes";
import { listRefileAction } from "./actions";

type Row = RefileItem & { state: "queued" | "working" | "moved" | "preview" | "unchanged" | "kept" | "skipped" | "failed"; detail: string };

const BUSY_WAIT_MS = 8_000;
const BUSY_RETRIES = 30;

async function refileFile(slug: string, id: string, apply: boolean): Promise<RefileResult> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`/c/${slug}/files/${id}/refile${apply ? "?apply=1" : ""}`, { method: "POST" });
    if (!response.ok && response.status !== 400) return { error: `The AI step failed (${response.status}).` };
    const result = (await response.json()) as RefileResult;
    if (!("outcome" in result) || result.outcome.status !== "busy" || attempt >= BUSY_RETRIES) return result;
    await new Promise((resolve) => setTimeout(resolve, BUSY_WAIT_MS));
  }
}

const csvOf = (rows: Row[]) => {
  const cell = (v: string) => `"${v.replaceAll('"', '""')}"`;
  return ["file,from,result,detail,id", ...rows.map((r) => [r.name, r.path, r.state, r.detail, r.id].map(cell).join(","))].join("\n");
};

export function Refiler({ slug, aiAvailable }: { slug: string; aiAvailable: boolean }) {
  const [scope, setScope] = useState<string>(REFILE_SCOPES[0].id);
  const [previewOnly, setPreviewOnly] = useState(true);
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState("");
  const stop = useRef(false);

  const patch = (id: string, change: Partial<Row>) => setRows((all) => all.map((r) => (r.id === id ? { ...r, ...change } : r)));

  async function start() {
    stop.current = false;
    setRunning(true);
    setNote("");
    const apply = !previewOnly;
    const files = await listRefileAction(slug, scope);
    setRows(files.map((f) => ({ ...f, state: "queued", detail: "" })));
    if (files.length === 0) setNote("No files in that group.");
    for (const file of files) {
      if (stop.current) break;
      patch(file.id, { state: "working" });
      try {
        const result = await refileFile(slug, file.id, apply);
        if ("error" in result) patch(file.id, { state: "failed", detail: result.error });
        else {
          const o = result.outcome;
          if (o.status === "moved" || o.status === "preview") patch(file.id, { state: o.status, detail: `${o.to} (${Math.round(o.confidence * 100)}%)` });
          else if (o.status === "unchanged") patch(file.id, { state: "unchanged", detail: "Already in the right place" });
          else if (o.status === "kept") patch(file.id, { state: "kept", detail: o.reason });
          else if (o.status === "skipped") patch(file.id, { state: "skipped", detail: o.reason });
          else patch(file.id, { state: "failed", detail: "The AI was busy for too long." });
        }
      } catch {
        patch(file.id, { state: "failed", detail: "The request failed." });
      }
    }
    setRunning(false);
  }

  const count = (s: Row["state"]) => rows.filter((r) => r.state === s).length;
  const finished = rows.length > 0 && !running;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm">
          Which files
          <NativeSelect value={scope} onChange={(e) => setScope(e.target.value)} disabled={running}>
            {REFILE_SCOPES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} — {s.hint}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" checked={previewOnly} onChange={(e) => setPreviewOnly(e.target.checked)} disabled={running} />
          Preview only (move nothing)
        </label>
        {running ? (
          <Button type="button" variant="outline" onClick={() => (stop.current = true)}>
            Stop
          </Button>
        ) : (
          <Button type="button" onClick={() => void start()} disabled={!aiAvailable}>
            <Sparkles />
            {previewOnly ? "Preview" : "Re-file now"}
          </Button>
        )}
        {running && <Loader2 className="size-4 animate-spin" />}
      </div>
      {!aiAvailable && <p className="text-sm text-amber-700">The AI is not set up on this server.</p>}
      {note && <p className="text-muted-foreground text-sm">{note}</p>}
      {rows.length > 0 && (
        <>
          <p className="text-sm">
            {rows.length} files · {count("moved") + count("preview")} {previewOnly ? "would move" : "moved"} · {count("unchanged")} already right · {count("kept")} kept · {count("skipped") + count("failed")} skipped
          </p>
          {finished && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() => {
                const url = URL.createObjectURL(new Blob([csvOf(rows)], { type: "text/csv" }));
                const a = document.createElement("a");
                a.href = url;
                a.download = `refile-${new Date().toISOString().slice(0, 10)}.csv`;
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              <Download />
              Download report
            </Button>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead className="hidden md:table-cell">Now in</TableHead>
                <TableHead>Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="max-w-64 truncate" dir="auto">{r.name}</TableCell>
                  <TableCell className="text-muted-foreground hidden max-w-64 truncate md:table-cell">{r.path}</TableCell>
                  <TableCell className="text-sm">
                    <span className="font-medium">{r.state === "preview" ? "would move to" : r.state === "moved" ? "moved to" : r.state}</span>
                    {r.detail && <span className="text-muted-foreground"> {r.detail}</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </div>
  );
}
