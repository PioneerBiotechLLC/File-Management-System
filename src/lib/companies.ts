import { z } from "zod";
import type { Role } from "@/generated/prisma/enums";
import type { Db } from "@/lib/db";
import { UserError } from "@/lib/errors";
import { seedDefaultFolders } from "@/lib/folders";
import { effectiveRole } from "@/lib/permissions";

/** Company slugs are shared with the sibling apps, e.g. `api-pharma`. */
export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "use lowercase letters, digits and single hyphens");

const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/, "must be a domain such as api-pharma.net");

const BRAND_COLOR = /^#[0-9a-f]{6}$/i;

/** The company's brand colour when it is a valid #rrggbb value. */
export function brandColor(primaryColor: string | null): string | null {
  return primaryColor && BRAND_COLOR.test(primaryColor) ? primaryColor : null;
}

export async function createCompany(
  prisma: Db,
  input: { slug: string; name: string; domain: string; actorEmail: string },
): Promise<{ id: string; slug: string; foldersCreated: number }> {
  const slug = slugSchema.parse(input.slug);
  const domain = domainSchema.parse(input.domain);
  const name = z.string().trim().min(1, "name is required").parse(input.name);

  return prisma.$transaction(async (tx) => {
    const taken = await tx.organization.findFirst({ where: { OR: [{ slug }, { domain }] }, select: { slug: true, domain: true } });
    if (taken) {
      throw new UserError(taken.slug === slug ? `A company with slug "${slug}" already exists.` : `Company "${taken.slug}" already uses ${domain}.`);
    }
    const org = await tx.organization.create({ data: { slug, name, domain }, select: { id: true, slug: true } });
    await tx.auditLog.create({
      data: { orgId: org.id, userEmail: input.actorEmail, action: "org.create", targetType: "organization", targetId: org.id, after: { slug, name, domain } },
    });
    const foldersCreated = await seedDefaultFolders(tx, org.id, "system");
    return { ...org, foldersCreated };
  }, { timeout: 60_000 });
}

type CompanySummary = { id: string; slug: string; name: string; role: Role };

/** Companies the user can open, with their role in each. Owners see every company as admins. */
export async function companiesForUser(prisma: Db, user: { id: string; isOwner: boolean }): Promise<CompanySummary[]> {
  if (user.isOwner) {
    const orgs = await prisma.organization.findMany({ select: { id: true, slug: true, name: true }, orderBy: { name: "asc" } });
    return orgs.map((o) => ({ ...o, role: "admin" }));
  }
  const memberships = await prisma.membership.findMany({
    where: { userId: user.id },
    select: { role: true, org: { select: { id: true, slug: true, name: true } } },
    orderBy: { org: { name: "asc" } },
  });
  return memberships.map((m) => ({ ...m.org, role: m.role }));
}

/** The company and the user's effective role in it, or null when the user may not open it (deactivation counts at once). */
export async function companyAccess(prisma: Db, slug: string, user: { id: string; isOwner: boolean }) {
  const [org, account] = await Promise.all([
    prisma.organization.findUnique({
      where: { slug },
      select: {
        id: true,
        slug: true,
        name: true,
        domain: true,
        timezone: true,
        logoUrl: true,
        primaryColor: true,
        memberships: { where: { userId: user.id }, select: { role: true } },
      },
    }),
    prisma.appUser.findUnique({ where: { id: user.id }, select: { isActive: true } }),
  ]);
  if (!org || !account?.isActive) return null;
  const { memberships, ...company } = org;
  const role = effectiveRole(user.isOwner, memberships[0]?.role ?? null);
  return role ? { org: company, role } : null;
}
