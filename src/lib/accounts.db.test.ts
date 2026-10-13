import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { TEST_DATABASE_URL, freshDatabase } from "@/test/database";
import { companiesForUser, companyAccess, createCompany } from "./companies";
import { UserError } from "./errors";
import { loadFolderAccess, seedDefaultFolders } from "./folders";
import { addMember, changeMemberRole, deactivateUser, listMembers, makeOwner, removeMember } from "./users";

describe.skipIf(!TEST_DATABASE_URL)("companies, users and folder access (database)", () => {
  let prisma: PrismaClient;
  let drop: () => Promise<void>;
  let orgId: string;
  let otherOrgId: string;
  const actor = { email: "admin@api-pharma.net" };

  beforeAll(async () => {
    ({ prisma, drop } = await freshDatabase());
    orgId = (await createCompany(prisma, { slug: "api-pharma", name: "API Pharma", domain: "API-Pharma.net", actorEmail: "cli:test" })).id;
    otherOrgId = (await createCompany(prisma, { slug: "beta-co", name: "Beta", domain: "beta.example", actorEmail: "cli:test" })).id;
  }, 60_000);

  afterAll(async () => drop?.());

  describe("createCompany", () => {
    it("stores the company with a lowercase domain, seeds folders and audits", async () => {
      const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
      expect(org).toMatchObject({ slug: "api-pharma", domain: "api-pharma.net", timezone: "Asia/Dubai" });
      expect(await prisma.folder.count({ where: { orgId } })).toBe(16);
      expect(await prisma.folder.count({ where: { orgId, access: "restricted" } })).toBe(2);
      expect(await prisma.auditLog.count({ where: { orgId, action: "org.create" } })).toBe(1);
    });

    it("refuses a duplicate slug or domain", async () => {
      await expect(createCompany(prisma, { slug: "api-pharma", name: "X", domain: "x.example", actorEmail: "t" })).rejects.toThrow(UserError);
      await expect(createCompany(prisma, { slug: "x", name: "X", domain: "api-pharma.net", actorEmail: "t" })).rejects.toThrow(UserError);
    });

    it("seeds folders idempotently", async () => {
      expect(await seedDefaultFolders(prisma, orgId, "system")).toBe(0);
      expect(await prisma.folder.count({ where: { orgId } })).toBe(16);
    });

    it("does not allow two top-level folders with the same name", async () => {
      await expect(prisma.folder.create({ data: { orgId, parentId: null, name: "General", createdBy: "t" } })).rejects.toThrow();
    });
  });

  describe("users", () => {
    it("adds a member, creating the user once and auditing", async () => {
      const first = await addMember(prisma, { orgId, email: " Sara@API-Pharma.net ", role: "editor", actor });
      expect(first.change).toBe("added");
      const again = await addMember(prisma, { orgId, email: "sara@api-pharma.net", role: "editor", actor });
      expect(again).toMatchObject({ userId: first.userId, change: "unchanged" });
      const promoted = await addMember(prisma, { orgId, email: "sara@api-pharma.net", role: "admin", actor });
      expect(promoted.change).toBe("role_changed");
      expect(await prisma.appUser.count({ where: { email: "sara@api-pharma.net" } })).toBe(1);
      const audit = await prisma.auditLog.findMany({ where: { orgId, targetId: first.userId }, orderBy: { createdAt: "asc" } });
      expect(audit.map((a) => a.action)).toEqual(["user.create", "membership.add", "membership.role"]);
      expect(audit[2]).toMatchObject({ before: { role: "editor" }, after: { role: "admin" }, userEmail: actor.email });
    });

    it("protects against changing or removing yourself", async () => {
      const { userId } = await addMember(prisma, { orgId, email: "self@api-pharma.net", role: "admin", actor });
      await expect(changeMemberRole(prisma, { orgId, userId, role: "viewer", actor: { ...actor, userId } })).rejects.toThrow(UserError);
      await expect(removeMember(prisma, { orgId, userId, actor: { ...actor, userId } })).rejects.toThrow(UserError);
    });

    it("removes a member and their grants in that company only", async () => {
      const { userId } = await addMember(prisma, { orgId, email: "hr@api-pharma.net", role: "editor", actor });
      await addMember(prisma, { orgId: otherOrgId, email: "hr@api-pharma.net", role: "editor", actor });
      const hr = await prisma.folder.findFirstOrThrow({ where: { orgId, name: "HR" } });
      const otherHr = await prisma.folder.findFirstOrThrow({ where: { orgId: otherOrgId, name: "HR" } });
      await prisma.folderGrant.createMany({ data: [{ folderId: hr.id, userId }, { folderId: otherHr.id, userId }] });

      await removeMember(prisma, { orgId, userId, actor });

      expect(await prisma.membership.count({ where: { userId } })).toBe(1);
      expect(await prisma.folderGrant.findMany({ where: { userId }, select: { folderId: true } })).toEqual([{ folderId: otherHr.id }]);
      expect(await prisma.appUser.count({ where: { id: userId } })).toBe(1);
    });

    it("keeps deactivated users out unless an owner reactivates them", async () => {
      await addMember(prisma, { orgId, email: "gone@api-pharma.net", role: "viewer", actor });
      await deactivateUser(prisma, { email: "gone@api-pharma.net", actor });
      // Without saying "deactivated": an admin of another company must not learn that.
      await expect(addMember(prisma, { orgId, email: "gone@api-pharma.net", role: "viewer", actor })).rejects.toThrow(/cannot be added from here/);
      const back = await addMember(prisma, { orgId, email: "gone@api-pharma.net", role: "viewer", actor, reactivate: true });
      expect(back.reactivated).toBe(true);
      expect((await prisma.appUser.findUniqueOrThrow({ where: { email: "gone@api-pharma.net" } })).isActive).toBe(true);
    });

    it("lists owners as admins alongside members", async () => {
      await makeOwner(prisma, { email: "owner@api-pharma.net", actor });
      const members = await listMembers(prisma, otherOrgId);
      expect(members.find((m) => m.email === "owner@api-pharma.net")).toMatchObject({ role: "admin", isOwner: true });
      expect(members.find((m) => m.email === "sara@api-pharma.net")).toBeUndefined();
    });
  });

  describe("company access", () => {
    it("gives owners admin everywhere and members their role; others nothing", async () => {
      const owner = await prisma.appUser.findUniqueOrThrow({ where: { email: "owner@api-pharma.net" } });
      const sara = await prisma.appUser.findUniqueOrThrow({ where: { email: "sara@api-pharma.net" } });
      expect((await companyAccess(prisma, "beta-co", owner))?.role).toBe("admin");
      expect((await companyAccess(prisma, "api-pharma", sara))?.role).toBe("admin");
      expect(await companyAccess(prisma, "beta-co", sara)).toBeNull();
      expect(await companyAccess(prisma, "missing", owner)).toBeNull();
      // Deactivation closes every company at once, not after the session's next reload.
      await prisma.appUser.update({ where: { id: sara.id }, data: { isActive: false } });
      expect(await companyAccess(prisma, "api-pharma", sara)).toBeNull();
      await prisma.appUser.update({ where: { id: sara.id }, data: { isActive: true } });
      expect((await companiesForUser(prisma, owner)).map((c) => c.slug)).toEqual(["api-pharma", "beta-co"]);
      expect((await companiesForUser(prisma, sara)).map((c) => c.slug)).toEqual(["api-pharma"]);
    });

    it("hides restricted folders without a grant", async () => {
      const { userId } = await addMember(prisma, { orgId, email: "viewer@api-pharma.net", role: "viewer", actor });
      const hr = await prisma.folder.findFirstOrThrow({ where: { orgId, name: "HR" } });
      const hrContracts = await prisma.folder.findFirstOrThrow({ where: { orgId, parentId: hr.id, name: "Contracts" } });

      const before = await loadFolderAccess(prisma, orgId, userId, "viewer");
      expect(before.visible.has(hr.id)).toBe(false);
      expect(before.visible.has(hrContracts.id)).toBe(false);
      expect(before.writable.size).toBe(0);

      await prisma.folderGrant.create({ data: { folderId: hr.id, userId } });
      const after = await loadFolderAccess(prisma, orgId, userId, "viewer");
      expect(after.visible.has(hrContracts.id)).toBe(true);
    });
  });
});
