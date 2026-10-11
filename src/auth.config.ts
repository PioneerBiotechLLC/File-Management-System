import type { NextAuthConfig } from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { emailFromProfile } from "@/lib/identity";

/**
 * The edge-safe half of the Auth.js config, shared with the middleware. No database imports here;
 * the allow-list and the periodic user reload live in auth.ts.
 */

const { AUTH_MICROSOFT_ENTRA_ID_ISSUER } = process.env;

export const SESSION_HOURS = 12;

export const authConfig = {
  pages: { signIn: "/signin", error: "/no-access" },
  session: { strategy: "jwt", maxAge: SESSION_HOURS * 60 * 60 },
  providers: [
    MicrosoftEntraID({
      // Multi-tenant, so the sibling apps' existing app registration can be reused.
      issuer: AUTH_MICROSOFT_ENTRA_ID_ISSUER || "https://login.microsoftonline.com/organizations/v2.0",
      profile: (profile) => ({
        id: String(profile.sub),
        name: typeof profile.name === "string" ? profile.name : null,
        email: emailFromProfile(profile),
      }),
    }),
  ],
  callbacks: {
    authorized: ({ auth }) => Boolean(auth?.user),
  },
} satisfies NextAuthConfig;
