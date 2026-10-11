import NextAuth, { type DefaultSession } from "next-auth";
import type {} from "next-auth/jwt";
import { SESSION_HOURS, authConfig } from "@/auth.config";
import { db } from "@/lib/db";

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

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    /** Only allow-listed, active users may sign in. */
    async signIn({ user }) {
      const email = user.email?.toLowerCase();
      if (!email) return "/no-access?reason=no_email";
      try {
        const row = await db().appUser.findUnique({ where: { email }, select: { isActive: true } });
        if (!row) return "/no-access?reason=not_listed";
        if (!row.isActive) return "/no-access?reason=inactive";
        return true;
      } catch (error) {
        console.error("[auth] sign-in check failed", error);
        return "/no-access?reason=error";
      }
    },
    async jwt({ token, user }) {
      const now = Date.now();
      if (user?.email) {
        const row = await db().appUser.update({
          where: { email: user.email.toLowerCase() },
          data: { lastLoginAt: new Date(), ...(user.name ? { name: user.name } : {}) },
          select: { id: true, email: true, name: true, isOwner: true },
        });
        return { ...token, userId: row.id, email: row.email, name: row.name, isOwner: row.isOwner, signedInAt: now, checkedAt: now };
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
});
