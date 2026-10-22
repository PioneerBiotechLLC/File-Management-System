"use client";

import { Loader2, Wand2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { settleReviewAction } from "./actions";

type Totals = { filed: number; unsure: number; deleted: number; kept: number };

/**
 * For admins: files everything in Review the way bulk upload does. Read files go where the AI
 * chose when it was sure, otherwise to General marked unsure; files too large for the AI go to
 * General by name; files it cannot read are deleted; failed reads are tried once more.
 */
export function SettleReview({ slug, toFile, toDelete, toRetry }: { slug: string; toFile: number; toDelete: number; toRetry: number }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [running, setRunning] = useState(false);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setAsking(false);
    setRunning(true);
    setError(null);
    const sum: Totals = { filed: 0, unsure: 0, deleted: 0, kept: 0 };
    setTotals({ ...sum });
    try {
      let after: string | null = null;
      do {
        const out = await settleReviewAction(slug, after);
        if (!out.ok) return setError(out.error);
        for (const key of ["filed", "unsure", "deleted", "kept"] as const) sum[key] += out.data[key];
        setTotals({ ...sum });
        after = out.data.next;
      } while (after !== null);
    } catch {
      setError("The connection dropped. Press the button again to carry on; files already done stay done.");
    } finally {
      setRunning(false);
      router.refresh();
    }
  };

  const total = toFile + toDelete + toRetry;
  if (total === 0 && !totals) return null;

  return (
    <div className="bg-card grid gap-3 rounded-xl border p-4 text-sm">
      {!asking && !running && (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={() => setAsking(true)} disabled={total === 0}>
            <Wand2 />
            File everything automatically
          </Button>
          <span className="text-muted-foreground">
            {toFile.toLocaleString("en")} to file, {toDelete.toLocaleString("en")} unreadable to delete{toRetry > 0 && <>, {toRetry.toLocaleString("en")} failed {toRetry === 1 ? "read" : "reads"} to try again</>}.
          </span>
        </div>
      )}
      {asking && (
        <div className="grid gap-2">
          <p>
            <strong>{toFile.toLocaleString("en")}</strong> files are filed with no one checking: where the AI chose when it was at least 60% sure, otherwise in General,
            marked unsure (files too large for the AI go to General under their own name). <strong>{toDelete.toLocaleString("en")}</strong> files the AI cannot read are
            deleted; they can be restored from{" "}
            <Link href={`/c/${slug}/trash`} className="underline">
              Deleted
            </Link>{" "}
            for 30 days.{toRetry > 0 && <> <strong>{toRetry.toLocaleString("en")}</strong> failed {toRetry === 1 ? "read is" : "reads are"} tried once more with the AI first, which takes a while.</>} Files still being read, and files someone has started confirming, stay here.
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void start()}>
              File {toFile.toLocaleString("en")}, delete {toDelete.toLocaleString("en")}{toRetry > 0 && <>, retry {toRetry.toLocaleString("en")}</>}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {totals && (
        <p className="flex items-center gap-2">
          {running && <Loader2 className="size-4 animate-spin" />}
          {running ? "Working… " : "Done. "}
          {totals.filed.toLocaleString("en")} filed, {totals.unsure.toLocaleString("en")} in General (unsure), {totals.deleted.toLocaleString("en")} deleted
          {totals.kept > 0 && <>, {totals.kept.toLocaleString("en")} left in Review</>}.{running && " Keep this page open."}
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
