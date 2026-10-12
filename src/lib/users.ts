import { z } from "zod";
import type { Role } from "@/generated/prisma/enums";
import type { Db } from "@/lib/db";
import { UserError } from "@/lib/errors";

/** Users are identified by lowercase email, the same as in the sibling apps. */
export const emailSchema = z.string().trim().toLowerCase().pipe(z.email("must be an email address"));
export const roleSchema = z.enum(["admin", "editor", "viewer"]);


type Actor = { email: string; userId?: string };

/**
 * Gives a user a role in a company, creating the user if needed. A deactivated user stays
 * deactivated unless `reactivate` is set (owners do that from the CLI).
 */
export async function addMember(
  prisma: Db,
  input: { orgId: string; email: string; role: Role; actor: Actor; reactivate?: boolean },
): Promise<{ userId: string; change: "added" | "role_changed" | "unchanged"; reactivated: boolean }> {
  const email = emailSchema.parse(input.email);
  const role = roleSchema.parse(input.role);
  return prisma.$transaction(async (tx) => {
    let user = await tx.appUser.findUnique({ where: { email }, select: { id: true, isActive: true } });
    const reactivated = Boolean(user && !user.isActive);
    if (!user) {
      user = await tx.appUser.create({ data: { email }, select: { id: true, isActive: true } });
      await tx.auditLog.create({
        data: { orgId: input.orgId, userEmail: input.actor.email, action: "user.create", targetType: "user", targetId: user.id, after: { email } },
      });
    } else if (!user.isActive) {
      // Not "deactivated": that would tell an admin of one company about a person's standing in another.
      if (!input.reactivate) throw new UserError(`${email} cannot be added from here. An owner can add them with "pnpm user add".`);
      await tx.appUser.update({ where: { id: user.id }, data: { isActive: true } });
      await tx.auditLog.create({
        data: { orgId: null, userEmail: input.actor.email, action: "user.reactivate", targetType: "user", targetId: user.id, after: { email } },
      });
    }

    const existing = await tx.membership.findUnique({
      where: { userId_orgId: { userId: user.id, orgId: input.orgId } },
      select: { id: true, role: true },
    });
    if (existing?.role === role) return { userId: user.id, change: "unchanged" as const, reactivated };
    if (existing) {
      await tx.membership.update({ where: { id: existing.id }, data: { role } });
    } else {
      await tx.membership.create({ data: { userId: user.id, orgId: input.orgId, role } });
    }
    await tx.auditLog.create({
      data: {
        orgId: input.orgId,
        userEmail: input.actor.email,
        action: existing ? "membership.role" : "membership.add",
        targetType: "user",
        targetId: user.id,
        before: existing ? { email, role: existing.role } : undefined,
        after: { email, role },
      },
    });
    return { userId: user.id, change: existing ? ("role_changed" as const) : ("added" as const), reactivated };
  });
}

export async function changeMemberRole(
  prisma: Db,
  input: { orgId: string; userId: string; role: Role; actor: Actor },
): Promise<void> {
  const role = roleSchema.parse(input.role);
  if (input.userId === input.actor.userId) throw new UserError("You cannot change your own role.");
  await prisma.$transaction(async (tx) => {
    const membership = await tx.membership.findUnique({
      where: { userId_orgId: { userId: input.userId, orgId: input.orgId } },
      select: { id: true, role: true, user: { select: { email: true } } },
    });
    if (!membership) throw new UserError("That person is not a member of this company.");
    if (membership.role === role) return;
    await tx.membership.update({ where: { id: membership.id }, data: { role } });
    await tx.auditLog.create({
      data: {
        orgId: input.orgId,
        userEmail: input.actor.email,
        action: "membership.role",
        targetType: "user",
        targetId: input.userId,
        before: { email: membership.user.email, role: membership.role },
        after: { email: membership.user.email, role },
      },
    });
  });
}

/** Removes a user from one company, including their folder grants there. The user row stays. */
export async function removeMember(prisma: Db, input: { orgId: string; userId: string; actor: Actor }): Promise<void> {
  if (input.userId === input.actor.userId) throw new UserError("You cannot remove yourself.");
  await prisma.$transaction(async (tx) => {
    const membership = await tx.membership.findUnique({
      where: { userId_orgId: { userId: input.userId, orgId: input.orgId } },
      select: { id: true, role: true, user: { select: { email: true } } },
    });
    if (!membership) throw new UserError("That person is not a member of this company.");
    await tx.membership.delete({ where: { id: membership.id } });
    await tx.folderGrant.deleteMany({ where: { userId: input.userId, folder: { orgId: input.orgId } } });
    await tx.auditLog.create({
      data: {
        orgId: input.orgId,
        userEmail: input.actor.email,
        action: "membership.remove",
        targetType: "user",
        targetId: input.userId,
        before: { email: membership.user.email, role: membership.role },
      },
    });
  });
}

/** Makes a user an owner (admin in every company), creating or reactivating them as needed. */
export async function makeOwner(prisma: Db, input: { email: string; actor: Actor }): Promise<{ userId: string }> {
  const email = emailSchema.parse(input.email);
  return prisma.$transaction(async (tx) => {
    const before = await tx.appUser.findUnique({ where: { email }, select: { isOwner: true, isActive: true } });
    const user = await tx.appUser.upsert({
      where: { email },
      create: { email, isOwner: true },
      update: { isOwner: true, isActive: true },
      select: { id: true },
    });
    await tx.auditLog.create({
      data: {
        orgId: null,
        userEmail: input.actor.email,
        action: "user.owner",
        targetType: "user",
        targetId: user.id,
        before: before ?? undefined,
        after: { email, isOwner: true, isActive: true },
      },
    });
    return { userId: user.id };
  });
}

/** Signs a user out of every company within five minutes; their row and history stay. */
export async function deactivateUser(prisma: Db, input: { email: string; actor: Actor }): Promise<void> {
  const email = emailSchema.parse(input.email);
  await prisma.$transaction(async (tx) => {
    const user = await tx.appUser.findUnique({ where: { email }, select: { id: true, isActive: true } });
    if (!user) throw new UserError(`${email} is not a user.`);
    if (!user.isActive) return;
    await tx.appUser.update({ where: { id: user.id }, data: { isActive: false } });
    await tx.auditLog.create({
      data: { orgId: null, userEmail: input.actor.email, action: "user.deactivate", targetType: "user", targetId: user.id, before: { email, isActive: true }, after: { email, isActive: false } },
    });
  });
}

type MemberRow = {
  userId: string;
  email: string;
  name: string | null;
  role: Role;
  isOwner: boolean;
  isActive: boolean;
  lastLoginAt: Date | null;
};

/** Everyone who can open the company: members, plus owners (admins everywhere) without a membership. */
export async function listMembers(prisma: Db, orgId: string): Promise<MemberRow[]> {
  const users = await prisma.appUser.findMany({
    where: { OR: [{ memberships: { some: { orgId } } }, { isOwner: true }] },
    select: {
      id: true,
      email: true,
      name: true,
      isOwner: true,
      isActive: true,
      lastLoginAt: true,
      memberships: { where: { orgId }, select: { role: true } },
    },
    orderBy: { email: "asc" },
  });
  return users.map((u) => ({
    userId: u.id,
    email: u.email,
    name: u.name,
    role: u.isOwner ? "admin" : (u.memberships[0]?.role ?? "viewer"),
    isOwner: u.isOwner,
    isActive: u.isActive,
    lastLoginAt: u.lastLoginAt,
  }));
}
