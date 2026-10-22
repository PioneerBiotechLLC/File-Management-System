"use client";

import { Clock, Loader2, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { BatchStatus } from "@/lib/batch-reading";
import { checkBatchesAction } from "./actions";

/** While something is out, the page drives batch reading itself this often (each call works for up to a minute and a half). */
const CHECK_EVERY_MS = 45 * 1000;

/**
 * For admins: where batch reading stands, a button that sends and checks right now, and, while
 * anything is out, the same check on a timer, so an open Review page keeps things moving.
 */
export function BatchNotice({ slug, status }: { slug: string; status: BatchStatus }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const active = status.waiting + status.sending + status.reading > 0;

  const check = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const out = await checkBatchesAction(slug);
      if (!out.ok) return setError(out.error);
      const { collected, sent, error: failed, status: now } = out.data;
      const parts = [
        sent > 0 ? `${sent} sent to the AI` : null,
        collected.finished > 0 ? `${collected.finished} finished ${collected.finished === 1 ? "batch" : "batches"} taken in: ${collected.filed} filed, ${collected.review} for review${collected.deleted ? `, ${collected.deleted} deleted` : ""}` : null,
        collected.partial ? `${collected.filed + collected.review + collected.deleted} results taken in so far; the rest follow` : null,
        collected.checked > 0 && collected.finished === 0 && !collected.partial ? "the AI is still reading" : null,
        collected.checked === 0 && now.collecting > 0 ? "results are being taken in right now" : null,
        collected.checked === 0 && sent === 0 && now.sending > 0 ? "a batch is being sent right now" : null,
      ].filter(Boolean);
      setMessage(parts.length ? `${parts.join("; ")}.` : "Nothing to do right now.");
      if (failed) setError(failed);
      router.refresh();
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [router, slug]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void check(), CHECK_EVERY_MS);
    return () => clearInterval(timer);
  }, [active, check]);

  if (!active && !status.lastError) return null;

  const since = status.oldestSentAt ? new Date(status.oldestSentAt).toLocaleString() : null;
  return (
    <div className="bg-card grid gap-2 rounded-xl border p-4 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <Clock className="size-4" />
        Batch reading
      </div>
      <p>
        <strong>{status.waiting.toLocaleString("en")}</strong> waiting to be sent{status.sending > 0 && <> · <strong>{status.sending.toLocaleString("en")}</strong> being sent now</>} ·{" "}
        <strong>{status.reading.toLocaleString("en")}</strong> with the AI{since && <> (since {since})</>}
        {status.collecting > 0 && <> · results being taken in now</>}. {active ? "While this page is open it checks every 45 seconds; " : "It is also "}
        {active ? "it is also moved" : "moved"} along by the cron job and whenever an admin opens this page.
      </p>
      {status.lastError && (
        <p role="alert" className="text-destructive">
          The last attempt failed: {status.lastError}
        </p>
      )}
      <div>
        <Button size="sm" onClick={() => void check()} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {busy ? "Working…" : "Send and check now"}
        </Button>
      </div>
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
