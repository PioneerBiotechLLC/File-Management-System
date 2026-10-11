import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "@/auth";
import { companyAccess } from "@/lib/companies";
import { db } from "@/lib/db";

/** The signed-in user, or a redirect to sign-in. Cached per request. */
export const currentUser = cache(async () => {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  return session.user;
});

/**
 * The company at `/c/<slug>` and the user's role in it, re-read from the database on every request.
 * Not a member (or no such company) is a real 404, thrown from the layout before streaming starts.
 * Server actions call this too, so the company and user always come from the session, never a form.
 */
export const companyContext = cache(async (slug: string) => {
  const user = await currentUser();
  const access = await companyAccess(db(), slug, user);
  if (!access) notFound();
  return { user, org: access.org, role: access.role };
});
