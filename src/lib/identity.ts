/**
 * The sign-in email for a Microsoft Entra profile, lowercased. Entra omits the `email` claim for
 * many work accounts, so fall back to `preferred_username`, then `upn`.
 */
export function emailFromProfile(profile: object): string | null {
  for (const claim of ["email", "preferred_username", "upn"]) {
    const value = (profile as Record<string, unknown>)[claim];
    if (typeof value === "string" && value.includes("@")) return value.trim().toLowerCase();
  }
  return null;
}
