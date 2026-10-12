"use client";

import { FileUp, Upload } from "lucide-react";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { useUploads } from "@/components/upload-provider";

/** Uploads into the folder that is open (or to Review when none is). */
export function UploadButton() {
  const { canUpload, pick } = useUploads();
  if (!canUpload) return null;
  return (
    <Button onClick={pick}>
      <Upload />
      Upload
    </Button>
  );
}

/** Adds a new version to one file. */
export function NewVersionButton({ fileId }: { fileId: string }) {
  const { uploadFiles } = useUploads();
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button variant="outline" onClick={() => input.current?.click()}>
        <FileUp />
        Upload new version
      </Button>
      <input
        ref={input}
        type="file"
        className="hidden"
        onChange={(e) => {
          uploadFiles(Array.from(e.target.files ?? []).slice(0, 1), { versionOf: fileId });
          e.target.value = "";
        }}
      />
    </>
  );
}
