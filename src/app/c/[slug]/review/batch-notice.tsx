"use client";

import { Clock, Loader2, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { BatchStatus } from "@/lib/batch-reading";
import { checkBatchesAction } from "./actions";

/** For admins: where batch reading stands, and a button that sends and checks right now. */
export function BatchNotice({ slug, status }: { slug: string; status: BatchStatus }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (status.waiting + status.reading === 0 && !status.lastError) return null;

  const check = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const out = await checkBatchesAction(slug);
      if (!out.ok) return setError(out.error);
      const { collected, sent, error: failed } = out.data;
      const parts = [
        sent > 0 ? `${sent} sent to the AI` : null,
        collected.finished > 0 ? `${collected.finished} finished ${collected.finished === 1 ? "batch" : "batches"} taken in: ${collected.filed} filed, ${collected.review} for review${collected.deleted ? `, ${collected.deleted} deleted` : ""}` : null,
        collected.checked > 0 && collected.finished === 0 ? "the AI is still reading" : null,
        collected.partial ? "more to take in; press again" : null,
      ].filter(Boolean);
      setMessage(parts.length ? `${parts.join("; ")}.` : "Nothing to do right now.");
      if (failed) setError(failed);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const since = status.oldestSentAt ? new Date(status.oldestSentAt).toLocaleString() : null;
  return (
    <div className="bg-card grid gap-2 rounded-xl border p-4 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <Clock className="size-4" />
        Batch reading
      </div>
      <p>
        <strong>{status.waiting.toLocaleString("en")}</strong> waiting to be sent · <strong>{status.reading.toLocaleString("en")}</strong> with the AI{since && <> (since {since})</>}.
        Moved along on its own every 15 minutes and whenever an admin opens this page.
      </p>
      {status.lastError && (
        <p role="alert" className="text-destructive">
          The last attempt failed: {status.lastError}
        </p>
      )}
      <div>
        <Button size="sm" onClick={() => void check()} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Send and check now
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
