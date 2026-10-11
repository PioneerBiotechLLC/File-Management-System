import { describe, expect, it } from "vitest";
import { emailFromProfile } from "./identity";

describe("emailFromProfile", () => {
  it("prefers the email claim, lowercased", () => {
    expect(emailFromProfile({ email: "Sara.Ali@API-Pharma.net", preferred_username: "x@y.z" })).toBe("sara.ali@api-pharma.net");
  });

  it("falls back to preferred_username, then upn", () => {
    expect(emailFromProfile({ preferred_username: "Omar@api-pharma.net" })).toBe("omar@api-pharma.net");
    expect(emailFromProfile({ email: null, upn: " Lina@api-pharma.net " })).toBe("lina@api-pharma.net");
  });

  it("skips claims that are not email addresses", () => {
    expect(emailFromProfile({ email: "", preferred_username: "omar", upn: "omar@api-pharma.net" })).toBe("omar@api-pharma.net");
    expect(emailFromProfile({ name: "No Email" })).toBeNull();
  });
});
