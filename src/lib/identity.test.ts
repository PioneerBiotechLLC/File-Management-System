import { describe, expect, it } from "vitest";
import { emailCandidates, emailFromProfile, entraIdentity } from "./identity";

describe("emailCandidates", () => {
  it("prefers the UPN forms over the email claim, lowercased and without duplicates", () => {
    expect(emailCandidates({ email: "Sara.Ali@API-Pharma.net", preferred_username: "sara.ali@api-pharma.net", upn: "Sara.Ali@api-pharma.net" })).toEqual([
      "sara.ali@api-pharma.net",
    ]);
    expect(emailCandidates({ email: "sara@mailbox.example", preferred_username: "sara@api-pharma.net" })).toEqual(["sara@api-pharma.net", "sara@mailbox.example"]);
  });

  it("skips claims that are not addresses, and guest-account names", () => {
    expect(emailCandidates({ email: "", preferred_username: "omar", upn: " Lina@api-pharma.net " })).toEqual(["lina@api-pharma.net"]);
    expect(emailCandidates({ preferred_username: "omar_gmail.com#EXT#@tenant.onmicrosoft.com", email: "omar@gmail.com" })).toEqual(["omar@gmail.com"]);
    expect(emailCandidates({ name: "No Email" })).toEqual([]);
  });

  it("emailFromProfile is the first candidate", () => {
    expect(emailFromProfile({ email: "x@y.z", upn: "Omar@api-pharma.net" })).toBe("omar@api-pharma.net");
    expect(emailFromProfile({})).toBeNull();
  });
});

describe("entraIdentity", () => {
  it("needs both the tenant and the object id", () => {
    expect(entraIdentity({ tid: "F88CF322-32F1-4974-9C41-FCE70D003DE2", oid: "ABC" })).toEqual({ tid: "f88cf322-32f1-4974-9c41-fce70d003de2", oid: "abc" });
    expect(entraIdentity({ tid: "t" })).toBeNull();
    expect(entraIdentity({ oid: 5, tid: "t" })).toBeNull();
  });
});
