import NextAuth, { type DefaultSession } from "next-auth";
import type {} from "next-auth/jwt";
import { SESSION_HOURS, authConfig } from "@/auth.config";
import { recordRefusedSignIn, recordSession } from "@/lib/audit-log";
import { db } from "@/lib/db";
import { allowedTenantIds } from "@/lib/env";
import { emailCandidates, entraIdentity, type EntraIdentity } from "@/lib/identity";

declare module "next-auth" {
  interface Session {
    user: { id: string; email: string; isOwner: boolean } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    isOwner?: boolean;
    signedInAt?: number;
    checkedAt?: number;
  }
}

/** How often a session re-reads the user, so deactivation takes effect within minutes. */
const RELOAD_MS = 5 * 60 * 1000;
const SESSION_MS = SESSION_HOURS * 60 * 60 * 1000;

const USER_SELECT = { id: true, email: true, name: true, isOwner: true, isActive: true, entraTid: true, entraOid: true } as const;

const boundTo = (identity: EntraIdentity) => ({ entraTid_entraOid: { entraTid: identity.tid, entraOid: identity.oid } });

/** The log must never stop anyone signing in or out. */
async function logQuietly(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    console.error("[auth] could not write the log", error);
  }
}

/**
 * The allow-listed user a Microsoft account signs in as. The account that first signed in as a
 * user is remembered (tenant and object id); afterwards only that account matches, however the
 * email claims read. Unbound users are matched by email and bound on this first sign-in.
 */
async function resolveUser(identity: EntraIdentity, candidates: string[]) {
  const prisma = db();
  const bound = await prisma.appUser.findUnique({ where: boundTo(identity), select: USER_SELECT });
  if (bound) return { row: bound, linked: false };

  const rows = await prisma.appUser.findMany({ where: { email: { in: candidates } }, select: USER_SELECT });
  const row = candidates.map((email) => rows.find((r) => r.email === email)).find(Boolean);
  if (!row) return { row: null, linked: false };
  // The email belongs to a user who signs in with a different Microsoft account.
  if (row.entraOid) return { row: null, linked: false, mismatch: row.email };
  if (!row.isActive) return { row, linked: false };
  const updated = await prisma.appUser.update({ where: { id: row.id }, data: { entraTid: identity.tid, entraOid: identity.oid }, select: USER_SELECT });
  return { row: updated, linked: true };
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    /** Only accounts from allowed tenants, matching an allow-listed, active user, may sign in. */
    async signIn({ profile }) {
      const identity = profile ? entraIdentity(profile) : null;
      if (!identity) return "/no-access?reason=no_tenant";
      // Refusals from other tenants are not logged: anyone with a Microsoft account could fill the log.
      if (!allowedTenantIds().has(identity.tid)) return "/no-access?reason=tenant";
      const candidates = profile ? emailCandidates(profile) : [];
      if (candidates.length === 0) return "/no-access?reason=no_email";
      try {
        const found = await resolveUser(identity, candidates);
        if (found.mismatch) {
          await logQuietly(() => recordRefusedSignIn(db(), found.mismatch, "account_mismatch"));
          return "/no-access?reason=account_mismatch";
        }
        if (!found.row || !found.row.isActive) {
          const reason = found.row ? "inactive" : "not_listed";
          await logQuietly(() => recordRefusedSignIn(db(), found.row?.email ?? candidates[0]!, reason));
          return `/no-access?reason=${reason}`;
        }
        if (found.linked) await logQuietly(() => recordSession(db(), "auth.linked", found.row, { tenant: identity.tid }));
        return true;
      } catch (error) {
        console.error("[auth] sign-in check failed", error);
        return "/no-access?reason=error";
      }
    },
    async jwt({ token, user, profile }) {
      const now = Date.now();
      if (user) {
        // signIn just bound this account; anything else here fails closed.
        const identity = profile ? entraIdentity(profile) : null;
        if (!identity) return null;
        const row = await db().appUser.findUnique({ where: boundTo(identity), select: USER_SELECT });
        if (!row?.isActive) return null;
        await db().appUser.update({ where: { id: row.id }, data: { lastLoginAt: new Date(), ...(user.name ? { name: user.name } : {}) } });
        await logQuietly(() => recordSession(db(), "auth.signin", row));
        return { ...token, userId: row.id, email: row.email, name: user.name ?? row.name, isOwner: row.isOwner, signedInAt: now, checkedAt: now };
      }
      // A session lasts 12 hours from sign-in, however active the user is.
      if (!token.userId || !token.signedInAt || now - token.signedInAt > SESSION_MS) return null;
      if (!token.checkedAt || now - token.checkedAt > RELOAD_MS) {
        const row = await db().appUser.findUnique({
          where: { id: token.userId },
          select: { email: true, name: true, isOwner: true, isActive: true },
        });
        if (!row?.isActive) return null;
        return { ...token, email: row.email, name: row.name, isOwner: row.isOwner, checkedAt: now };
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = token.userId ?? "";
      session.user.email = token.email ?? "";
      session.user.isOwner = token.isOwner === true;
      return session;
    },
  },
  events: {
    async signOut(message) {
      const token = "token" in message ? message.token : null;
      if (token?.userId && token.email) {
        const user = { id: token.userId, email: token.email };
        await logQuietly(() => recordSession(db(), "auth.signout", user));
      }
    },
  },
});
