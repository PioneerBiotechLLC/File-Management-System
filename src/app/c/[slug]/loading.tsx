import { Loader2 } from "lucide-react";

/** Shown at once on every click inside a company, while the next page loads. */
export default function Loading() {
  return (
    <div role="status" className="text-muted-foreground flex items-center justify-center gap-2 py-24 text-sm">
      <Loader2 className="size-4 animate-spin" />
      Loading…
    </div>
  );
}
