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
 * chose when it was sure, otherwise to General marked unsure; files it cannot read are deleted.
 */
export function SettleReview({ slug, toFile, toDelete }: { slug: string; toFile: number; toDelete: number }) {
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
      } while (after);
    } catch {
      setError("The connection dropped. Press the button again to carry on; files already done stay done.");
    } finally {
      setRunning(false);
      router.refresh();
    }
  };

  if (toFile + toDelete === 0 && !totals) return null;

  return (
    <div className="bg-card grid gap-3 rounded-xl border p-4 text-sm">
      {!asking && !running && (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={() => setAsking(true)} disabled={toFile + toDelete === 0}>
            <Wand2 />
            File everything automatically
          </Button>
          <span className="text-muted-foreground">
            {toFile.toLocaleString("en")} read by the AI to file, {toDelete.toLocaleString("en")} it cannot read to delete.
          </span>
        </div>
      )}
      {asking && (
        <div className="grid gap-2">
          <p>
            <strong>{toFile.toLocaleString("en")}</strong> files the AI read are filed with no one checking: where the AI chose when it was at least 60% sure, otherwise in
            General, marked unsure. <strong>{toDelete.toLocaleString("en")}</strong> files the AI cannot read are deleted; they can be restored from{" "}
            <Link href={`/c/${slug}/trash`} className="underline">
              Deleted
            </Link>{" "}
            for 30 days. Files too large for the AI, files still being read and reads that failed stay here.
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void start()}>
              File {toFile.toLocaleString("en")} and delete {toDelete.toLocaleString("en")}
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
