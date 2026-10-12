"use client";

import { Download, Loader2, Search, Sparkles } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { FileIcon } from "@/components/file-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import type { AskResult } from "@/lib/ask";
import { DOC_TYPES, DOC_TYPE_LABELS, type DocType } from "@/lib/doc-types";
import { formatBytes } from "@/lib/file-names";
import type { SearchFilters, SearchHit } from "@/lib/search";
import { askAction, searchAction } from "./actions";

type Folder = { id: string; path: string };
type Initial = { q: string; folderId: string; docType: string; dateFrom: string; dateTo: string };

const DEBOUNCE_MS = 350;

/** Renders « » marks from the database as highlights. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(«[^»]*»)/);
  return (
    <p dir="auto" className="text-muted-foreground text-sm">
      {parts.map((part, i) =>
        part.startsWith("«") ? (
          <mark key={i} className="rounded bg-yellow-100 px-0.5 text-foreground">
            {part.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </p>
  );
}

function Hit({ slug, hit, why, timezone }: { slug: string; hit: SearchHit; why?: string; timezone: string }) {
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, dateStyle: "medium" });
  const amounts = hit.facts.amounts.slice(0, 3).map((a) => `${a.value.toLocaleString("en")} ${a.currency}`);
  return (
    <li className="grid gap-1.5 p-4">
      <div className="flex items-start gap-2">
        <FileIcon name={hit.name} mimeType={hit.mimeType} className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <Link href={`/c/${slug}/files/${hit.id}`} dir="auto" className="block truncate font-medium hover:underline">
            {hit.title ?? hit.name}
          </Link>
          <p className="text-muted-foreground truncate text-xs" dir="auto">
            {hit.folderPath ?? "Not filed yet"} · {hit.name} · {formatBytes(hit.sizeBytes)}
            {hit.docDate && <> · {date.format(hit.docDate)}</>}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button asChild variant="outline" size="sm">
            <Link href={`/c/${slug}/files/${hit.id}`}>Open</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href={`/c/${slug}/files/${hit.id}/download`} aria-label={`Download ${hit.name}`}>
              <Download />
            </a>
          </Button>
        </div>
      </div>
      {why ? <p dir="auto" className="text-sm">{why}</p> : <Snippet text={hit.snippet} />}
      <div className="flex flex-wrap gap-1.5">
        {hit.docType && <Badge variant="secondary">{DOC_TYPE_LABELS[hit.docType as DocType] ?? hit.docType}</Badge>}
        {hit.facts.parties.slice(0, 2).map((p) => (
          <Badge key={p} variant="outline" dir="auto">
            {p}
          </Badge>
        ))}
        {amounts.map((a) => (
          <Badge key={a} variant="outline">
            {a}
          </Badge>
        ))}
      </div>
    </li>
  );
}

export function SearchBox({ slug, folders, timezone, aiAvailable, initial }: { slug: string; folders: Folder[]; timezone: string; aiAvailable: boolean; initial: Initial }) {
  const [q, setQ] = useState(initial.q);
  const [folderId, setFolderId] = useState(initial.folderId);
  const [docType, setDocType] = useState(initial.docType);
  const [dateFrom, setDateFrom] = useState(initial.dateFrom);
  const [dateTo, setDateTo] = useState(initial.dateTo);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<AskResult | null>(null);
  const [asking, startAsk] = useTransition();
  const latest = useRef(0);

  const filters: SearchFilters = {
    folderId: folderId || null,
    docType: (docType as DocType) || null,
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
  };
  const filterKey = JSON.stringify(filters);
  const hasFilters = Boolean(folderId || docType || dateFrom || dateTo);

  // Keep the address in step so a search can be shared or reloaded.
  useEffect(() => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (folderId) params.set("folder", folderId);
    if (docType) params.set("type", docType);
    if (dateFrom) params.set("from", dateFrom);
    if (dateTo) params.set("to", dateTo);
    const text = params.toString();
    window.history.replaceState(null, "", `/c/${slug}/search${text ? `?${text}` : ""}`);
  }, [slug, q, folderId, docType, dateFrom, dateTo]);

  const search = useCallback(async () => {
    if (!q.trim() && !hasFilters) {
      setHits(null);
      setSearching(false);
      return;
    }
    const ticket = ++latest.current;
    setSearching(true);
    const result = await searchAction(slug, { q, filters: JSON.parse(filterKey) as SearchFilters });
    if (ticket !== latest.current) return;
    setSearching(false);
    if (result.ok) {
      setHits(result.data.hits);
      setError(null);
    } else setError(result.error);
  }, [slug, q, filterKey, hasFilters]);

  useEffect(() => {
    const timer = setTimeout(() => void search(), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const askAi = () => {
    if (!q.trim() || asking) return;
    startAsk(async () => {
      setAnswer(null);
      const result = await askAction(slug, { question: q });
      if (result.ok) setAnswer(result.data);
      else setError(result.error);
    });
  };

  return (
    <div className="grid max-w-4xl gap-4">
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (aiAvailable) askAi();
        }}
      >
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by company, product, number, amount… or ask a question"
              className="h-11 pl-9 text-base"
              autoFocus
              aria-label="Search"
            />
          </div>
          {aiAvailable && (
            <Button type="submit" className="h-11" disabled={asking || !q.trim()}>
              {asking ? <Loader2 className="animate-spin" /> : <Sparkles />}
              Ask AI
            </Button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <NativeSelect value={folderId} onChange={(e) => setFolderId(e.target.value)} aria-label="Folder" className="max-w-64">
            <option value="">All folders</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.path}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect value={docType} onChange={(e) => setDocType(e.target.value)} aria-label="Type">
            <option value="">Any type</option>
            {DOC_TYPES.map((t) => (
              <option key={t} value={t}>
                {DOC_TYPE_LABELS[t]}
              </option>
            ))}
          </NativeSelect>
          <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} aria-label="From date" className="w-40" />
          <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} aria-label="To date" className="w-40" />
          {hasFilters && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setFolderId("");
                setDocType("");
                setDateFrom("");
                setDateTo("");
              }}
            >
              Clear filters
            </Button>
          )}
        </div>
      </form>

      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}

      {(asking || answer) && (
        <section className="bg-muted/40 grid gap-3 rounded-xl border p-4">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="text-brand size-4" />
            AI answer
          </h2>
          {asking ? (
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" />
              Searching the summaries… this takes a few seconds.
            </p>
          ) : (
            answer && (
              <>
                <p dir="auto" className="text-sm">
                  {answer.text}
                </p>
                {answer.files.length > 0 && (
                  <ul className="bg-card divide-y rounded-lg border">
                    {answer.files.map((f) => (
                      <Hit key={f.id} slug={slug} hit={f} why={f.why} timezone={timezone} />
                    ))}
                  </ul>
                )}
              </>
            )
          )}
        </section>
      )}

      {hits !== null && (
        <section className="grid gap-2">
          <h2 className="text-muted-foreground flex items-center gap-2 text-sm">
            {searching && <Loader2 className="size-3.5 animate-spin" />}
            {hits.length === 0 ? "No matching files." : `${hits.length} ${hits.length === 1 ? "file" : "files"}${hits.length >= 20 ? " (showing the best 20)" : ""}`}
          </h2>
          {hits.length > 0 && (
            <ul className="divide-y rounded-lg border">
              {hits.map((h) => (
                <Hit key={h.id} slug={slug} hit={h} timezone={timezone} />
              ))}
            </ul>
          )}
        </section>
      )}
      {hits === null && !answer && !asking && (
        <p className="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
          Results appear as you type. {aiAvailable ? "Press Enter or Ask AI for questions like “the insulin quotation we sent Gulf Pharmacy last spring, around 40k AED”." : ""}
        </p>
      )}
    </div>
  );
}
