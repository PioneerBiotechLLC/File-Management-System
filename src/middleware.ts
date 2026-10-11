import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/auth.config";
import { LAST_COMPANY_COOKIE } from "@/lib/cookies";

const { auth } = NextAuth(authConfig);

/** Signed-in users only (the `authorized` callback redirects others); remembers the last company opened. */
export default auth((req) => {
  const res = NextResponse.next();
  const slug = req.nextUrl.pathname.match(/^\/c\/([a-z0-9-]+)(?:\/|$)/)?.[1];
  if (slug) {
    res.cookies.set(LAST_COMPANY_COOKIE, slug, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
  }
  return res;
});

export const config = {
  // Public: sign-in, the no-access page, Auth.js itself, the health check, cron jobs and static assets.
  matcher: ["/((?!signin|no-access|api/auth/|api/health|api/cron/|_next/static|_next/image|favicon\\.ico|icon\\.svg).*)"],
};
