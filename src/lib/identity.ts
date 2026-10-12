/**
 * Who a Microsoft Entra token says is signing in.
 *
 * The `email` claim is whatever the issuing tenant's admin typed, so on its own it proves nothing;
 * the tenant (`tid`) and object (`oid`) ids are what Entra guarantees. Sign-in therefore checks the
 * tenant against the allow-list first, then matches the person by email, preferring the UPN forms
 * (`upn`, `preferred_username`), which must be on a domain the tenant owns, over `email`.
 */

export type EntraIdentity = { tid: string; oid: string };

/** The tenant and object ids, or null when either is missing. */
export function entraIdentity(profile: object): EntraIdentity | null {
  const p = profile as Record<string, unknown>;
  const tid = typeof p.tid === "string" ? p.tid.trim().toLowerCase() : "";
  const oid = typeof p.oid === "string" ? p.oid.trim().toLowerCase() : "";
  return tid && oid ? { tid, oid } : null;
}

/**
 * The emails the token offers for this account, lowercased, most trustworthy first and without
 * duplicates. A user whose UPN differs from their mailbox address is found by the later entries.
 */
export function emailCandidates(profile: object): string[] {
  const p = profile as Record<string, unknown>;
  const out: string[] = [];
  for (const claim of ["upn", "preferred_username", "email"]) {
    const value = p[claim];
    if (typeof value !== "string" || !value.includes("@")) continue;
    const email = value.trim().toLowerCase();
    // Guest accounts carry "name_domain.com#EXT#@tenant.onmicrosoft.com", which is not an address.
    if (email.includes("#ext#")) continue;
    if (!out.includes(email)) out.push(email);
  }
  return out;
}

/** The first email the token offers; for display and for Auth.js's profile, never for access. */
export function emailFromProfile(profile: object): string | null {
  return emailCandidates(profile)[0] ?? null;
}
