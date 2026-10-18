import { describe, expect, it } from "vitest";
import { bearerMatches, sameSecret } from "./api-auth";

const req = (authorization?: string) => new Request("https://files.test/api/x", { headers: authorization ? { authorization } : {} });

describe("bearerMatches", () => {
  it("accepts the configured secret and nothing else", () => {
    expect(bearerMatches(req("Bearer s3cret-s3cret-s3cret-s3cret-s3cret"), "s3cret-s3cret-s3cret-s3cret-s3cret")).toBe(true);
    expect(bearerMatches(req("bearer s3cret-s3cret-s3cret-s3cret-s3cret"), "s3cret-s3cret-s3cret-s3cret-s3cret")).toBe(true);
    expect(bearerMatches(req("Bearer other"), "s3cret-s3cret-s3cret-s3cret-s3cret")).toBe(false);
    expect(bearerMatches(req("Bearer "), "s3cret-s3cret-s3cret-s3cret-s3cret")).toBe(false);
    expect(bearerMatches(req(), "s3cret-s3cret-s3cret-s3cret-s3cret")).toBe(false);
  });
  it("is closed when no secret is configured", () => {
    expect(bearerMatches(req("Bearer anything"), undefined)).toBe(false);
    expect(bearerMatches(req("Bearer "), "")).toBe(false);
  });
  it("compares secrets of different lengths without throwing", () => {
    expect(sameSecret("a", "ab")).toBe(false);
    expect(sameSecret("same", "same")).toBe(true);
  });
});
