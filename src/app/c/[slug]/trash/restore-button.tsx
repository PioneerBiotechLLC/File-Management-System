"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { restoreFileAction } from "@/app/c/[slug]/actions";
import { Button } from "@/components/ui/button";

export function RestoreButton({ slug, fileId }: { slug: string; fileId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="grid justify-items-end gap-1">
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await restoreFileAction(slug, { fileId });
            if (result.ok) router.refresh();
            else setError(result.error);
          })
        }
      >
        Restore
      </Button>
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
}
