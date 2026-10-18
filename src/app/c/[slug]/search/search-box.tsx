"use client";

import { Download, Loader2, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
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
import { AskBox, type SearchMode } from "./ask-box";

type Folder = { id: string; path: string };
type Initial = { q: string; ai: boolean; folderId: string; docType: string; dateFrom: string; dateTo: string };
type Query = { q: string; mode: SearchMode; n: number };

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
        {hit.unsure && <Badge variant="outline">Unsure</Badge>}
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
  const [query, setQuery] = useState<Query | null>(
    initial.q ? { q: initial.q, mode: initial.ai && aiAvailable ? "ai" : "keyword", n: 0 } : null,
  );
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
  const asked = useRef(-1);
  const [askedWith, setAskedWith] = useState<string | null>(null);

  const filters: SearchFilters = {
    folderId: folderId || null,
    docType: (docType as DocType) || null,
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
  };
  const filterKey = JSON.stringify(filters);
  const hasFilters = Boolean(folderId || docType || dateFrom || dateTo);
  const mode = query?.mode ?? "keyword";

  // Keep the address in step so a search can be shared or reloaded; never with ai=1, so a reload costs nothing.
  useEffect(() => {
    const params = new URLSearchParams();
    if (query?.q) params.set("q", query.q);
    if (folderId) params.set("folder", folderId);
    if (docType) params.set("type", docType);
    if (dateFrom) params.set("from", dateFrom);
    if (dateTo) params.set("to", dateTo);
    const text = params.toString();
    window.history.replaceState(null, "", `/c/${slug}/search${text ? `?${text}` : ""}`);
  }, [slug, query, folderId, docType, dateFrom, dateTo]);

  // Search (no AI): runs for each search and again when a filter changes.
  useEffect(() => {
    if (mode !== "keyword") return;
    const q = query?.q ?? "";
    if (!q && !hasFilters) {
      setHits(null);
      return;
    }
    const ticket = ++latest.current;
    setSearching(true);
    void searchAction(slug, { q, filters: JSON.parse(filterKey) as SearchFilters }).then((result) => {
      if (ticket !== latest.current) return;
      setSearching(false);
      if (result.ok) {
        setHits(result.data.hits);
        setError(null);
      } else setError(result.error);
    });
  }, [slug, query, mode, filterKey, hasFilters]);

  // AI search: once per press, with the filters chosen at that moment.
  useEffect(() => {
    if (!query || query.mode !== "ai" || asked.current === query.n) return;
    asked.current = query.n;
    setAskedWith(filterKey);
    startAsk(async () => {
      setAnswer(null);
      const result = await askAction(slug, { question: query.q, filters: JSON.parse(filterKey) as SearchFilters });
      if (result.ok) {
        setAnswer(result.data);
        setError(null);
      } else setError(result.error);
    });
  }, [slug, query, filterKey]);

  const submit = (q: string, next: SearchMode) => {
    latest.current++;
    setSearching(false);
    setError(null);
    if (next === "ai") setHits(null);
    else setAnswer(null);
    setQuery({ q, mode: next, n: (query?.n ?? 0) + 1 });
  };

  return (
    <div className="grid max-w-4xl gap-4">
      <div className="grid gap-3">
        <AskBox slug={slug} aiAvailable={aiAvailable} initial={initial.q} busy={asking ? "ai" : searching ? "keyword" : null} onSubmit={submit} />
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
        {mode === "ai" && answer && askedWith !== filterKey && (
          <p className="text-muted-foreground text-xs">The filters changed. Press AI search again to use them.</p>
        )}
      </div>

      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}

      {(asking || answer) && (
        <section className="bg-muted/40 grid gap-3 rounded-xl border p-4">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="text-brand size-4" />
            AI search
          </h2>
          {asking ? (
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" />
              Reading the summaries… this takes 5–20 seconds.
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

      {mode === "keyword" && hits !== null && (
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
      {hits === null && !answer && !asking && !error && (
        <p className="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
          <strong className="text-foreground font-medium">Search</strong> finds files by words and numbers in their summaries: a company, product, reference or amount. It uses no AI.
          {aiAvailable && (
            <>
              {" "}
              <strong className="text-foreground font-medium">AI search</strong> reads the summaries to answer questions like “the insulin quotation we sent Gulf Pharmacy last spring, around 40k AED”, with the details.
            </>
          )}
        </p>
      )}
    </div>
  );
}
