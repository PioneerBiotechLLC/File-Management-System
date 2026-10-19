"use client";

import { Clock, Loader2, RefreshCw, Send } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { BatchStatus, CollectResult } from "@/lib/batch-reading";
import { collectBatchesAction, submitBatchAction } from "./actions";

/** Checked this often while a batch is with the AI and the page is open. */
const CHECK_EVERY_MS = 2 * 60 * 1000;

/**
 * Batch reading on the bulk page: what waits to be sent, what the AI is reading, and what came
 * back. While a batch is out it checks every two minutes; the daily cron catches anything left.
 */
export function BatchPanel({ slug, status, onStatus }: { slug: string; status: BatchStatus; onStatus: (s: BatchStatus) => void }) {
  const [busy, setBusy] = useState<"send" | "check" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<{ at: Date; result: CollectResult } | null>(null);
  const [totals, setTotals] = useState({ filed: 0, review: 0 });

  const check = useCallback(async () => {
    setBusy("check");
    setError(null);
    try {
      const out = await collectBatchesAction(slug);
      if (!out.ok) return setError(out.error);
      setLast({ at: new Date(), result: out.data.collected });
      setTotals((t) => ({ filed: t.filed + out.data.collected.filed, review: t.review + out.data.collected.review }));
      onStatus(out.data.status);
    } finally {
      setBusy(null);
    }
  }, [onStatus, slug]);

  const send = async () => {
    setBusy("send");
    setError(null);
    try {
      for (;;) {
        const out = await submitBatchAction(slug);
        if (!out.ok) return setError(out.error);
        if (out.data.sent === 0 || out.data.waiting === 0) break;
      }
      const out = await collectBatchesAction(slug);
      if (out.ok) onStatus(out.data.status);
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (status.reading === 0) return;
    const timer = setInterval(() => void check(), CHECK_EVERY_MS);
    return () => clearInterval(timer);
  }, [check, status.reading]);

  if (status.waiting === 0 && status.reading === 0 && !last) return null;

  return (
    <div className="bg-card grid gap-3 rounded-xl border p-4 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <Clock className="size-4" />
        Batch reading (half price)
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1">
        <span>
          <strong>{status.waiting.toLocaleString("en")}</strong> waiting to be sent
        </span>
        <span>
          <strong>{status.reading.toLocaleString("en")}</strong> with the AI
        </span>
        {(totals.filed > 0 || totals.review > 0) && (
          <span>
            Came back: <strong>{totals.filed.toLocaleString("en")}</strong> filed, <strong>{totals.review.toLocaleString("en")}</strong> for review
          </span>
        )}
      </div>
      <p className="text-muted-foreground">
        Results come back within 24 hours, usually within the hour. This page checks every two minutes while it is open; you can also close it, and the daily
        check picks results up.
        {last && <> Last checked {last.at.toLocaleTimeString()}.</>}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {status.waiting > 0 && (
          <Button size="sm" onClick={() => void send()} disabled={busy !== null}>
            {busy === "send" ? <Loader2 className="animate-spin" /> : <Send />}
            Send {status.waiting.toLocaleString("en")} waiting {status.waiting === 1 ? "file" : "files"}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => void check()} disabled={busy !== null}>
          {busy === "check" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Check for results now
        </Button>
        {totals.review > 0 && (
          <Link href={`/c/${slug}/review`} className="underline">
            Open Review
          </Link>
        )}
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
