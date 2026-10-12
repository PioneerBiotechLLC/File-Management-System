"use client";

import { ChevronRight, Folder, FolderOpen, Lock } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

type TreeFolder = { id: string; parentId: string | null; name: string; nameAr: string | null; access: "everyone" | "restricted" };

/** The open folder and every folder above it. */
function pathTo(folders: TreeFolder[], selectedId: string | undefined): Set<string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path = new Set<string>();
  for (let f = selectedId ? byId.get(selectedId) : undefined; f && !path.has(f.id); f = f.parentId ? byId.get(f.parentId) : undefined) path.add(f.id);
  return path;
}

/**
 * The folders the user may see, as nested links. A folder with subfolders has an arrow that shows or hides them.
 * Only the path to the open folder starts expanded; opening another folder expands its path too.
 */
export function FolderTree({ slug, folders, selectedId }: { slug: string; folders: TreeFolder[]; selectedId: string | undefined }) {
  const open = pathTo(folders, selectedId);
  const [expanded, setExpanded] = useState(() => open);

  // Opening a folder from elsewhere on the page (a subfolder button, a breadcrumb) reveals it in the tree.
  useEffect(() => {
    setExpanded((current) => {
      const path = pathTo(folders, selectedId);
      if ([...path].every((id) => current.has(id))) return current;
      return new Set([...current, ...path]);
    });
  }, [folders, selectedId]);

  const hasChildren = new Set(folders.map((f) => f.parentId).filter((id): id is string => id !== null));

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function Branch({ parentId }: { parentId: string | null }) {
    const items = folders.filter((f) => f.parentId === parentId);
    if (items.length === 0) return null;
    return (
      <ul className={parentId ? "border-border ml-3 border-l pl-1" : "grid gap-0.5"}>
        {items.map((f) => {
          const isExpanded = expanded.has(f.id);
          return (
            <li key={f.id}>
              <div className="flex items-center">
                {hasChildren.has(f.id) ? (
                  <button
                    type="button"
                    onClick={() => toggle(f.id)}
                    aria-expanded={isExpanded}
                    aria-label={`${isExpanded ? "Collapse" : "Expand"} ${f.name}`}
                    className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded-md"
                  >
                    <ChevronRight className={cn("size-3.5 transition-transform", isExpanded && "rotate-90")} />
                  </button>
                ) : (
                  <span className="size-6 shrink-0" />
                )}
                <Link
                  href={`/c/${slug}?folder=${f.id}`}
                  aria-current={f.id === selectedId ? "page" : undefined}
                  className={cn(
                    "hover:bg-accent flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                    f.id === selectedId && "bg-accent font-medium",
                    f.id !== selectedId && open.has(f.id) && "font-medium",
                  )}
                >
                  {f.id === selectedId ? <FolderOpen className="size-4 shrink-0" /> : <Folder className="text-muted-foreground size-4 shrink-0" />}
                  <span dir="auto" className="min-w-0 flex-1 truncate">
                    {f.name}
                  </span>
                  {f.access === "restricted" && <Lock className="text-muted-foreground size-3 shrink-0" aria-label="Restricted" />}
                </Link>
              </div>
              {isExpanded && <Branch parentId={f.id} />}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <nav aria-label="Folders" className="grid gap-1">
      <Link
        href={`/c/${slug}`}
        className={cn("hover:bg-accent rounded-md px-2 py-1.5 text-sm", !selectedId && "bg-accent font-medium")}
        aria-current={!selectedId ? "page" : undefined}
      >
        All recent files
      </Link>
      <Branch parentId={null} />
    </nav>
  );
}
