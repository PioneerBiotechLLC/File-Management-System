import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { listGrants } from "@/lib/folder-admin";
import { folderPaths } from "@/lib/folders";
import { can } from "@/lib/permissions";
import { companyContext } from "@/lib/session";
import { listMembers } from "@/lib/users";
import { FolderSettings, type FolderRow } from "./folder-settings";
import { CompanySettings } from "./company-settings";
import { UsersSettings } from "./users-settings";

export const metadata = { title: "Settings" };

export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { org, role, user } = await companyContext(slug);
  if (!can(role, "settings.manage")) notFound();

  const prisma = db();
  const [members, rawFolders] = await Promise.all([
    listMembers(prisma, org.id),
    prisma.folder.findMany({
      where: { orgId: org.id, kind: "regular" },
      select: { id: true, parentId: true, name: true, nameAr: true, description: true, access: true, isActive: true, sortOrder: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
  ]);
  const paths = folderPaths(rawFolders);
  const grants = new Map(
    await Promise.all(rawFolders.filter((f) => f.access === "restricted").map(async (f) => [f.id, await listGrants(prisma, org.id, f.id)] as const)),
  );
  // Tree order, so children follow their parent.
  const folders: FolderRow[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const f of rawFolders.filter((r) => r.parentId === parentId)) {
      folders.push({
        ...f,
        depth,
        path: paths.get(f.id) ?? f.name,
        grants: (grants.get(f.id) ?? []).map((g) => ({ userId: g.userId, email: g.user.email, name: g.user.name, canWrite: g.canWrite })),
      });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  const grantable = members.filter((m) => m.isActive && !m.isOwner && m.role !== "admin").map((m) => ({ userId: m.userId, email: m.email, name: m.name }));
  const formatDate = new Intl.DateTimeFormat("en-GB", { timeZone: org.timezone, dateStyle: "medium", timeStyle: "short" });

  return (
    <div className="grid max-w-4xl gap-6">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-muted-foreground text-sm">Folders and people at {org.name}.</p>
      </div>
      <FolderSettings slug={slug} folders={folders} grantable={grantable} />
      {user.isOwner && <CompanySettings slug={slug} name={org.name} logoUrl={org.logoUrl} primaryColor={org.primaryColor} />}
      <UsersSettings
        slug={slug}
        currentUserId={user.id}
        members={members.map((m) => ({
          userId: m.userId,
          email: m.email,
          name: m.name,
          role: m.role,
          isOwner: m.isOwner,
          isActive: m.isActive,
          lastLogin: m.lastLoginAt ? formatDate.format(m.lastLoginAt) : null,
        }))}
      />
    </div>
  );
}
