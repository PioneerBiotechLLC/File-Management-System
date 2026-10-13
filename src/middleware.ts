import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/auth.config";
import { LAST_COMPANY_COOKIE } from "@/lib/cookies";

const { auth } = NextAuth(authConfig);

/**
 * Signed-in users only. Every page and handler checks the session again itself; this is the
 * safety net for anything that forgets. Also remembers the last company opened.
 */
export default auth((req) => {
  if (!req.auth?.user) {
    // Auth.js only redirects from its `authorized` callback when no function is given, so do it here.
    const signIn = req.nextUrl.clone();
    signIn.pathname = "/signin";
    signIn.search = "";
    if (req.nextUrl.pathname !== "/") signIn.searchParams.set("callbackUrl", req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(signIn);
  }
  const res = NextResponse.next();
  const slug = req.nextUrl.pathname.match(/^\/c\/([a-z0-9-]+)(?:\/|$)/)?.[1];
  if (slug) {
    res.cookies.set(LAST_COMPANY_COOKIE, slug, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return res;
});

export const config = {
  // Public: sign-in, the no-access page, Auth.js itself, the health check, cron jobs (which check
  // CRON_SECRET themselves) and static assets. Whole path segments only, so /signin-x is still protected.
  matcher: ["/((?!(?:signin|no-access|api/health)(?:/|$)|api/auth/|api/cron/|_next/static|_next/image|favicon\\.ico|icon\\.png|brand/).*)"],
};
