import { createHash, timingSafeEqual } from "node:crypto";

/** Constant-time comparison of two strings of any length. */
export function sameSecret(a: string, b: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Whether the request carries `Authorization: Bearer <secret>`. False when the secret is not
 * configured, so an endpoint without its secret set is closed, never open.
 */
export function bearerMatches(request: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  return token.length > 0 && sameSecret(token, secret);
}
