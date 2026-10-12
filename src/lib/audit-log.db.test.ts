import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { TEST_DATABASE_URL, freshDatabase } from "@/test/database";
import { listAuditLog, recordRefusedSignIn, recordSession } from "./audit-log";
import { createCompany } from "./companies";
import { addMember, makeOwner } from "./users";

describe.skipIf(!TEST_DATABASE_URL)("audit log (database)", () => {
  let prisma: PrismaClient;
  let drop: () => Promise<void>;
  let orgId: string;
  let otherOrgId: string;
  let saraId: string;

  beforeAll(async () => {
    ({ prisma, drop } = await freshDatabase());
    orgId = (await createCompany(prisma, { slug: "api-pharma", name: "API Pharma", domain: "api-pharma.net", actorEmail: "t" })).id;
    otherOrgId = (await createCompany(prisma, { slug: "beta-co", name: "Beta", domain: "beta.example", actorEmail: "t" })).id;
    ({ userId: saraId } = await addMember(prisma, { orgId, email: "sara@api-pharma.net", role: "editor", actor: { email: "admin@api-pharma.net" } }));
    await addMember(prisma, { orgId: otherOrgId, email: "sara@api-pharma.net", role: "viewer", actor: { email: "t" } });
  }, 60_000);

  afterAll(async () => drop?.());

  it("records a sign-in in every company the person belongs to", async () => {
    await recordSession(prisma, "auth.signin", { id: saraId, email: "sara@api-pharma.net" });
    const rows = await prisma.auditLog.findMany({ where: { action: "auth.signin" } });
    expect(rows.map((r) => r.orgId).sort()).toEqual([orgId, otherOrgId].sort());
    expect(rows.every((r) => r.userEmail === "sara@api-pharma.net")).toBe(true);
  });

  it("files a refused sign-in under the company that owns the email domain", async () => {
    await recordRefusedSignIn(prisma, "stranger@api-pharma.net", "not_listed");
    await recordRefusedSignIn(prisma, "someone@elsewhere.example", "not_listed");
    const rows = await prisma.auditLog.findMany({ where: { action: "auth.refused" }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.orgId, r.userEmail])).toEqual([
      [orgId, "stranger@api-pharma.net"],
      [null, "someone@elsewhere.example"],
    ]);
  });

  it("lists one company's entries, filtered by person and type", async () => {
    const all = await listAuditLog(prisma, { orgId, includeUnscoped: false });
    expect(all.items.every((i) => i.orgId === orgId)).toBe(true);
    expect(all.people).toEqual(["admin@api-pharma.net", "sara@api-pharma.net", "stranger@api-pharma.net", "t"]);

    const signins = await listAuditLog(prisma, { orgId, includeUnscoped: false, category: "signins" });
    expect(signins.items.map((i) => i.action).sort()).toEqual(["auth.refused", "auth.signin"]);

    const sara = await listAuditLog(prisma, { orgId, includeUnscoped: false, email: "sara@api-pharma.net" });
    expect(sara.items.map((i) => i.action)).toEqual(["auth.signin"]);
  });

  it("shows owners the entries tied to no company", async () => {
    await makeOwner(prisma, { email: "boss@api-pharma.net", actor: { email: "cli" } });
    const forAdmin = await listAuditLog(prisma, { orgId, includeUnscoped: false, category: "people" });
    const forOwner = await listAuditLog(prisma, { orgId, includeUnscoped: true, category: "people" });
    expect(forAdmin.items.some((i) => i.action === "user.owner")).toBe(false);
    expect(forOwner.items.some((i) => i.action === "user.owner")).toBe(true);
  });
});
