import { Folder, Lock } from "lucide-react";
import { db } from "@/lib/db";
import { loadFolderAccess } from "@/lib/folders";
import { companyContext } from "@/lib/session";

type FolderRow = Awaited<ReturnType<typeof loadFolderAccess>>["folders"][number];

export default async function CompanyHome({ params }: { params: Promise<{ slug: string }> }) {
  const { org, role, user } = await companyContext((await params).slug);
  const prisma = db();
  const { folders, visible } = await loadFolderAccess(prisma, org.id, user.id, role);
  const counts = await prisma.storedFile.groupBy({
    by: ["folderId"],
    where: { orgId: org.id, deletedAt: null, folderId: { in: [...visible] } },
    _count: { _all: true },
  });
  const countByFolder = new Map(counts.map((c) => [c.folderId, c._count._all]));
  const shown = folders.filter((f) => visible.has(f.id) && f.isActive);
  const children = (parentId: string | null) => shown.filter((f) => f.parentId === parentId);

  function Branch({ parentId, depth }: { parentId: string | null; depth: number }) {
    const items = children(parentId);
    if (items.length === 0) return null;
    return (
      <ul className={depth > 0 ? "ml-6 border-l pl-3" : "grid gap-1"}>
        {items.map((f) => (
          <li key={f.id}>
            <FolderLine folder={f} count={countByFolder.get(f.id) ?? 0} />
            <Branch parentId={f.id} depth={depth + 1} />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="grid gap-4">
      <div>
        <h1 className="text-xl font-semibold">Folders</h1>
        <p className="text-muted-foreground text-sm">Where {org.name}&apos;s documents are filed.</p>
      </div>
      {shown.length === 0 ? (
        <p className="text-muted-foreground text-sm">No folders yet. An admin can create them with <code>pnpm folders seed</code>.</p>
      ) : (
        <Branch parentId={null} depth={0} />
      )}
    </div>
  );
}

function FolderLine({ folder, count }: { folder: FolderRow; count: number }) {
  return (
    <div className="flex items-start gap-2 rounded-md px-2 py-1.5">
      <Folder className="text-muted-foreground mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-medium">{folder.name}</span>
          {folder.nameAr && (
            <span dir="rtl" className="text-muted-foreground">
              {folder.nameAr}
            </span>
          )}
          {folder.access === "restricted" && <Lock className="text-muted-foreground size-3" aria-label="Restricted" />}
          <span className="text-muted-foreground text-xs">
            {count} {count === 1 ? "file" : "files"}
          </span>
        </div>
        {folder.description && (
          <p dir="auto" className="text-muted-foreground text-xs">
            {folder.description}
          </p>
        )}
      </div>
    </div>
  );
}
