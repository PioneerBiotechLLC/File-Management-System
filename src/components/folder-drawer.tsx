"use client";

import { ChevronDown, FolderTree as FolderIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

/** On a phone the folder tree folds away behind a button; from tablet width up it is always shown. */
export function FolderDrawer({ current, children }: { current: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="bg-card hover:bg-accent flex w-full items-center gap-2 rounded-lg border px-3 py-2.5 text-sm md:hidden"
      >
        <FolderIcon className="text-muted-foreground size-4 shrink-0" />
        <span dir="auto" className="min-w-0 flex-1 truncate text-left font-medium">
          {current}
        </span>
        <ChevronDown className={cn("text-muted-foreground size-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      <div className={cn("mt-2 max-h-80 overflow-y-auto md:mt-0 md:block md:max-h-none", open ? "block" : "hidden")}>{children}</div>
    </div>
  );
}
