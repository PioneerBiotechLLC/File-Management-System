"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { moveFileAction } from "@/app/c/[slug]/actions";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";

export function ReviewRow({ slug, fileId, folders }: { slug: string; fileId: string; folders: { id: string; path: string }[] }) {
  const router = useRouter();
  const [folderId, setFolderId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <form
      className="grid gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const result = await moveFileAction(slug, { fileId, folderId });
          if (result.ok) router.refresh();
          else setError(result.error);
        });
      }}
    >
      <div className="flex gap-2">
        <NativeSelect className="min-w-0 flex-1" value={folderId} onChange={(e) => setFolderId(e.target.value)} aria-label="Folder" required>
          <option value="" disabled>
            Choose a folder…
          </option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.path}
            </option>
          ))}
        </NativeSelect>
        <Button type="submit" disabled={pending || !folderId}>
          File it
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </form>
  );
}
