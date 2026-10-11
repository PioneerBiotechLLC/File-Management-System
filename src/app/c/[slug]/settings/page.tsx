import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { can } from "@/lib/permissions";
import { companyContext } from "@/lib/session";
import { listMembers } from "@/lib/users";
import { UsersSettings } from "./users-settings";

export const metadata = { title: "Settings" };

export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { org, role, user } = await companyContext(slug);
  if (!can(role, "settings.manage")) notFound();

  const members = await listMembers(db(), org.id);
  const formatDate = new Intl.DateTimeFormat("en-GB", { timeZone: org.timezone, dateStyle: "medium", timeStyle: "short" });

  return (
    <div className="grid max-w-4xl gap-6">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-muted-foreground text-sm">Who can use Files at {org.name}.</p>
      </div>
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
