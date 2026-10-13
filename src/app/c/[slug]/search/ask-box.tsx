"use client";

import { Loader2, Search, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type SearchMode = "keyword" | "ai";

/**
 * One box, two buttons: Search matches words in the confirmed summaries and uses no AI; AI search
 * has Claude read the summaries for a deeper, detailed answer. Enter searches, Ctrl/⌘+Enter asks
 * the AI. Without `onSubmit` (on the Files page) it opens the search page with the query.
 */
export function AskBox({
  slug,
  aiAvailable,
  initial = "",
  folder,
  busy = null,
  onSubmit,
  className,
}: {
  slug: string;
  aiAvailable: boolean;
  initial?: string;
  /** Searches only this folder and its subfolders. */
  folder?: { id: string; name: string };
  busy?: SearchMode | null;
  onSubmit?: (q: string, mode: SearchMode) => void;
  className?: string;
}) {
  const router = useRouter();
  const [q, setQ] = useState(initial);
  const empty = !q.trim();

  const submit = (mode: SearchMode) => {
    if (empty || busy || (mode === "ai" && !aiAvailable)) return;
    if (onSubmit) return onSubmit(q.trim(), mode);
    const params = new URLSearchParams({ q: q.trim() });
    if (folder) params.set("folder", folder.id);
    if (mode === "ai") params.set("ai", "1");
    router.push(`/c/${slug}/search?${params}`);
  };

  return (
    <form
      className={cn(
        "bg-card focus-within:border-ring focus-within:ring-ring/50 grid gap-2 rounded-xl border p-3 shadow-xs transition-[box-shadow] focus-within:ring-[3px]",
        className,
      )}
      onSubmit={(e) => {
        e.preventDefault();
        submit("keyword");
      }}
    >
      <textarea
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
          e.preventDefault();
          submit(e.metaKey || e.ctrlKey ? "ai" : "keyword");
        }}
        rows={2}
        maxLength={500}
        dir="auto"
        aria-label="Search files"
        placeholder={
          folder
            ? `Search in ${folder.name}: a company, product, reference number… or ask a question`
            : "Search by company, product, reference number, amount… or ask a question"
        }
        className="placeholder:text-muted-foreground field-sizing-content max-h-48 min-h-14 w-full resize-none bg-transparent px-1 text-base outline-none"
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <p className="text-muted-foreground mr-auto hidden px-1 text-xs sm:block">
          Enter to search{aiAvailable ? " · Ctrl+Enter for AI search" : ""}
        </p>
        <Button type="submit" variant="outline" disabled={empty || busy !== null}>
          {busy === "keyword" ? <Loader2 className="animate-spin" /> : <Search />}
          Search
        </Button>
        {aiAvailable && (
          <Button type="button" onClick={() => submit("ai")} disabled={empty || busy !== null}>
            {busy === "ai" ? <Loader2 className="animate-spin" /> : <Sparkles />}
            AI search
          </Button>
        )}
      </div>
    </form>
  );
}
