import { Folder, FolderOpen, Lock } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";

type TreeFolder = { id: string; parentId: string | null; name: string; nameAr: string | null; access: "everyone" | "restricted" };

/** The folders the user may see, as nested links. The open folder and its ancestors are highlighted. */
export function FolderTree({ slug, folders, selectedId }: { slug: string; folders: TreeFolder[]; selectedId: string | undefined }) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const open = new Set<string>();
  for (let f = selectedId ? byId.get(selectedId) : undefined; f && !open.has(f.id); f = f.parentId ? byId.get(f.parentId) : undefined) open.add(f.id);

  function Branch({ parentId }: { parentId: string | null }) {
    const items = folders.filter((f) => f.parentId === parentId);
    if (items.length === 0) return null;
    return (
      <ul className={parentId ? "border-border ml-3 border-l pl-1" : "grid gap-0.5"}>
        {items.map((f) => (
          <li key={f.id}>
            <Link
              href={`/c/${slug}?folder=${f.id}`}
              aria-current={f.id === selectedId ? "page" : undefined}
              className={cn(
                "hover:bg-accent flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
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
            <Branch parentId={f.id} />
          </li>
        ))}
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
