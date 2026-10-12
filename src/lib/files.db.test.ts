import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";
import { TEST_DATABASE_URL, freshDatabase } from "@/test/database";

const stored = new Map<string, number>();
const removed: string[] = [];

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    presignUpload: async (key: string) => `https://bucket.test/put/${key}`,
    presignDownload: async (key: string, name: string, o: { inline?: boolean } = {}) =>
      `https://bucket.test/get/${key}?name=${encodeURIComponent(name)}&inline=${o.inline ? 1 : 0}`,
    head: async (key: string) => (stored.has(key) ? { sizeBytes: stored.get(key)!, contentType: null } : null),
    remove: async (key: string) => {
      removed.push(key);
      stored.delete(key);
    },
  };
});

const { createCompany } = await import("./companies");
const { addMember } = await import("./users");
const { createFolder, grantAccess, revokeAccess, setFolderActive, updateFolder } = await import("./folder-admin");
const files = await import("./files");
const { UserError } = await import("./errors");

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe.skipIf(!TEST_DATABASE_URL)("files and folders (database)", () => {
  let prisma: PrismaClient;
  let drop: () => Promise<void>;
  let orgId: string;
  let otherOrgId: string;
  const ids: Record<string, string> = {};
  const folder: Record<string, string> = {};

  const ctxFor = (who: "admin" | "sara" | "omar" | "vic" | "hr") =>
    files.fileContext(prisma, { orgId, userId: ids[who]!, email: `${who}@api-pharma.net`, role: roles[who] });
  const roles: Record<"admin" | "sara" | "omar" | "vic" | "hr", Role> = { admin: "admin", sara: "editor", omar: "editor", vic: "viewer", hr: "editor" };

  /** Starts and confirms an upload, as the browser would. */
  async function upload(who: "admin" | "sara" | "omar" | "hr", name: string, content: string, folderId?: string | null) {
    const ctx = await ctxFor(who);
    const started = await files.startUpload(prisma, ctx, {
      name,
      size: content.length,
      mimeType: name.endsWith(".pdf") ? "application/pdf" : "application/octet-stream",
      sha256: sha(content),
      folderId: folderId ?? null,
      allowDuplicate: true,
    });
    if (started.kind !== "upload") throw new Error("expected an upload");
    stored.set(`${orgId}/${started.fileId}/${started.versionNo}`, content.length);
    return files.confirmUpload(prisma, ctx, { fileId: started.fileId, versionNo: started.versionNo });
  }

  beforeAll(async () => {
    ({ prisma, drop } = await freshDatabase());
    orgId = (await createCompany(prisma, { slug: "api-pharma", name: "API Pharma", domain: "api-pharma.net", actorEmail: "t" })).id;
    otherOrgId = (await createCompany(prisma, { slug: "beta-co", name: "Beta", domain: "beta.example", actorEmail: "t" })).id;
    for (const who of ["admin", "sara", "omar", "vic", "hr"] as const) {
      ({ userId: ids[who]! } = await addMember(prisma, { orgId, email: `${who}@api-pharma.net`, role: roles[who], actor: { email: "t" } }));
    }
    for (const f of await prisma.folder.findMany({ where: { orgId }, include: { parent: true } })) {
      folder[f.parent ? `${f.parent.name}/${f.name}` : f.name] = f.id;
    }
    // Only "hr" holds a grant on the restricted HR folder (and writes there).
    await grantAccess(prisma, { orgId, email: "t" }, { folderId: folder.HR!, userId: ids.hr!, canWrite: true });
  }, 60_000);

  afterAll(async () => drop?.());

  beforeEach(() => {
    removed.length = 0;
  });

  describe("upload", () => {
    it("creates a hidden pending file, then files it into the chosen folder on confirm", async () => {
      const ctx = await ctxFor("sara");
      const started = await files.startUpload(prisma, ctx, {
        name: "C:\\docs\\QT-2291.pdf",
        size: 11,
        mimeType: "application/pdf",
        sha256: sha("quotation 1"),
        folderId: folder["Sales/Quotations"],
      });
      expect(started).toMatchObject({ kind: "upload", versionNo: 1, name: "QT-2291.pdf", contentType: "application/pdf" });
      if (started.kind !== "upload") return;
      expect(started.uploadUrl).toBe(`https://bucket.test/put/${orgId}/${started.fileId}/1`);

      // Not visible while uploading.
      expect((await files.listFiles(prisma, ctx, { folderId: folder["Sales/Quotations"] })).total).toBe(0);
      expect(await files.getFile(prisma, ctx, started.fileId)).toBeNull();

      stored.set(`${orgId}/${started.fileId}/1`, 11);
      const done = await files.confirmUpload(prisma, ctx, { fileId: started.fileId, versionNo: 1 });
      expect(done).toMatchObject({ status: "ready", folderPath: "Sales / Quotations", name: "QT-2291.pdf" });

      const detail = await files.getFile(prisma, ctx, started.fileId);
      expect(detail).toMatchObject({ status: "ready", filedBy: "sara@api-pharma.net", currentVersion: 1, folderPath: "Sales / Quotations" });
      expect(detail?.versions).toHaveLength(1);
      expect(await prisma.auditLog.count({ where: { orgId, action: "file.upload", targetId: started.fileId } })).toBe(1);

      // Confirming again changes nothing.
      expect(await files.confirmUpload(prisma, ctx, { fileId: started.fileId, versionNo: 1 })).toMatchObject({ status: "ready" });
      expect(await prisma.auditLog.count({ where: { orgId, action: "file.upload", targetId: started.fileId } })).toBe(1);
    });

    it("leaves a file without a folder waiting in Review", async () => {
      const done = await upload("sara", "scan0042.pdf", "unfiled scan", null);
      expect(done).toMatchObject({ status: "needs_review", folderPath: null });
      const ctx = await ctxFor("sara");
      expect(await files.countUnfiled(prisma, ctx)).toBeGreaterThanOrEqual(1);
      expect((await files.listUnfiled(prisma, ctx)).map((f) => f.name)).toContain("scan0042.pdf");
    });

    it("rejects viewers, blocked files, oversized files and folders the user cannot write to", async () => {
      const base = { size: 10, mimeType: "application/pdf", sha256: sha("x") };
      await expect(files.startUpload(prisma, await ctxFor("admin").then((c) => ({ ...c, role: "viewer" as const })), { ...base, name: "a.pdf" })).rejects.toThrow(/permission/);
      await expect(files.startUpload(prisma, await ctxFor("sara"), { ...base, name: "setup.exe" })).rejects.toThrow(/executable or script/);
      await expect(files.startUpload(prisma, await ctxFor("sara"), { ...base, name: "big.pdf", size: 101 * 1024 * 1024 })).rejects.toThrow(/100 MB/);
      await expect(files.startUpload(prisma, await ctxFor("sara"), { ...base, name: "a.pdf", folderId: folder.HR })).rejects.toThrow(/cannot upload to that folder/);
      await expect(files.startUpload(prisma, await ctxFor("sara"), { ...base, name: "a.pdf", folderId: "nope" })).rejects.toThrow(/cannot upload/);
    });

    it("discards an upload whose bytes are missing or the wrong size", async () => {
      const ctx = await ctxFor("sara");
      const make = async (n: string) => {
        const s = await files.startUpload(prisma, ctx, { name: n, size: 20, mimeType: "application/pdf", sha256: sha(n), allowDuplicate: true });
        if (s.kind !== "upload") throw new Error("expected upload");
        return s;
      };
      const missing = await make("missing.pdf");
      await expect(files.confirmUpload(prisma, ctx, { fileId: missing.fileId, versionNo: 1 })).rejects.toThrow(/did not finish/);

      const wrong = await make("wrong.pdf");
      stored.set(`${orgId}/${wrong.fileId}/1`, 5);
      await expect(files.confirmUpload(prisma, ctx, { fileId: wrong.fileId, versionNo: 1 })).rejects.toThrow(/not the size expected/);
      expect(removed).toContain(`${orgId}/${wrong.fileId}/1`);
      expect(await prisma.storedFile.count({ where: { id: wrong.fileId } })).toBe(0);
    });

    it("lets only the uploader confirm", async () => {
      const s = await files.startUpload(prisma, await ctxFor("sara"), { name: "mine.pdf", size: 5, mimeType: "application/pdf", sha256: sha("mine"), allowDuplicate: true });
      if (s.kind !== "upload") throw new Error("expected upload");
      stored.set(`${orgId}/${s.fileId}/1`, 5);
      await expect(files.confirmUpload(prisma, await ctxFor("omar"), { fileId: s.fileId, versionNo: 1 })).rejects.toThrow(UserError);
    });
  });

  describe("duplicates", () => {
    it("reports an identical file, and lets the user upload anyway", async () => {
      await upload("sara", "price-list.pdf", "price list march", folder["Sales/Price Lists"]);
      const ctx = await ctxFor("omar");
      const again = await files.startUpload(prisma, ctx, { name: "copy.pdf", size: 15, mimeType: "application/pdf", sha256: sha("price list march") });
      expect(again).toMatchObject({ kind: "duplicate", existing: { name: "price-list.pdf", folderPath: "Sales / Price Lists" } });
      const forced = await files.startUpload(prisma, ctx, { name: "copy.pdf", size: 15, mimeType: "application/pdf", sha256: sha("price list march"), allowDuplicate: true });
      expect(forced.kind).toBe("upload");
    });

    it("does not reveal a duplicate the user cannot see", async () => {
      await upload("hr", "contract-ahmed.pdf", "ahmed employment contract", folder["HR/Contracts"]);
      const attempt = await files.startUpload(prisma, await ctxFor("sara"), {
        name: "mine.pdf",
        size: 25,
        mimeType: "application/pdf",
        sha256: sha("ahmed employment contract"),
      });
      expect(attempt.kind).toBe("upload");
    });

    it("ignores other people's unfiled files", async () => {
      await upload("omar", "private-scan.pdf", "omar unfiled scan", null);
      const attempt = await files.startUpload(prisma, await ctxFor("sara"), { name: "x.pdf", size: 17, mimeType: "application/pdf", sha256: sha("omar unfiled scan") });
      expect(attempt.kind).toBe("upload");
      const asAdmin = await files.startUpload(prisma, await ctxFor("admin"), { name: "x.pdf", size: 17, mimeType: "application/pdf", sha256: sha("omar unfiled scan") });
      expect(asAdmin.kind).toBe("duplicate");
    });
  });

  describe("versions", () => {
    it("adds a version, keeps older ones downloadable and refuses an identical one", async () => {
      const first = await upload("sara", "spec.pdf", "spec v1", folder["Quality & Regulatory/SOPs"]);
      const ctx = await ctxFor("sara");
      await expect(files.startUpload(prisma, ctx, { name: "spec.pdf", size: 7, mimeType: "application/pdf", sha256: sha("spec v1"), fileId: first.fileId })).rejects.toThrow(/identical/);

      const v2 = await files.startUpload(prisma, ctx, { name: "spec-final.docx", size: 15, mimeType: "application/vnd.x", sha256: sha("spec v2 changed"), fileId: first.fileId });
      if (v2.kind !== "upload") throw new Error("expected upload");
      expect(v2).toMatchObject({ versionNo: 2, name: "spec.pdf" });
      // Pending: the file still shows version 1.
      expect((await files.getFile(prisma, ctx, first.fileId))?.currentVersion).toBe(1);

      stored.set(`${orgId}/${first.fileId}/2`, 15);
      await files.confirmUpload(prisma, ctx, { fileId: first.fileId, versionNo: 2 });
      const detail = await files.getFile(prisma, ctx, first.fileId);
      expect(detail).toMatchObject({ currentVersion: 2, sizeBytes: 15, mimeType: "application/vnd.x" });
      expect(detail?.versions.map((v) => v.versionNo)).toEqual([2, 1]);

      const old = await files.downloadTarget(prisma, ctx, { fileId: first.fileId, versionNo: 1 });
      expect(old.url).toContain(`${first.fileId}/1`);
      expect(old.name).toBe("spec.pdf");
      expect((await files.downloadTarget(prisma, ctx, { fileId: first.fileId })).url).toContain(`${first.fileId}/2`);
      await expect(files.downloadTarget(prisma, ctx, { fileId: first.fileId, versionNo: 3 })).rejects.toThrow(UserError);
    });

    it("blocks a second uploader while one is pending, and replaces its own abandoned attempt", async () => {
      const first = await upload("sara", "plan.pdf", "plan v1", folder["Sales/Quotations"]);
      const sara = await ctxFor("sara");
      const admin = await ctxFor("admin");
      const a = await files.startUpload(prisma, sara, { name: "plan.pdf", size: 8, mimeType: "application/pdf", sha256: sha("plan v2"), fileId: first.fileId });
      expect(a.kind).toBe("upload");
      await expect(files.startUpload(prisma, admin, { name: "plan.pdf", size: 8, mimeType: "application/pdf", sha256: sha("plan v3"), fileId: first.fileId })).rejects.toThrow(/Someone else/);
      const retry = await files.startUpload(prisma, sara, { name: "plan.pdf", size: 8, mimeType: "application/pdf", sha256: sha("plan v2b"), fileId: first.fileId });
      expect(retry).toMatchObject({ kind: "upload", versionNo: 2 });
      expect(await prisma.fileVersion.count({ where: { fileId: first.fileId } })).toBe(2);
    });

    it("lets an editor add versions only to their own files", async () => {
      const first = await upload("sara", "mine-only.pdf", "mine only v1", folder["Sales/Quotations"]);
      await expect(
        files.startUpload(prisma, await ctxFor("omar"), { name: "x.pdf", size: 5, mimeType: "application/pdf", sha256: sha("other"), fileId: first.fileId }),
      ).rejects.toThrow(/only add versions/);
      const asAdmin = await files.startUpload(prisma, await ctxFor("admin"), { name: "x.pdf", size: 5, mimeType: "application/pdf", sha256: sha("other"), fileId: first.fileId });
      expect(asAdmin.kind).toBe("upload");
    });
  });

  describe("access is enforced in the queries", () => {
    let secretId: string;
    let secretOrg2Id: string;

    beforeAll(async () => {
      secretId = (await upload("hr", "salary-review.pdf", "salary review 2026", folder["HR/Personnel"])).fileId;
      const org2 = await prisma.appUser.create({ data: { email: "x@beta.example" } });
      secretOrg2Id = (
        await prisma.storedFile.create({
          data: { orgId: otherOrgId, name: "beta-file.pdf", originalName: "beta-file.pdf", mimeType: "application/pdf", sizeBytes: 1, sha256: sha("beta"), status: "ready", uploadedBy: org2.id },
        })
      ).id;
    });

    it("never shows a restricted file to someone without the grant", async () => {
      for (const who of ["sara", "omar", "vic"] as const) {
        const ctx = await ctxFor(who);
        const everything = await files.listFiles(prisma, ctx);
        expect(everything.items.map((f) => f.id)).not.toContain(secretId);
        expect((await files.listFiles(prisma, ctx, { folderId: folder["HR/Personnel"] })).total).toBe(0);
        expect(await files.getFile(prisma, ctx, secretId)).toBeNull();
        await expect(files.downloadTarget(prisma, ctx, { fileId: secretId })).rejects.toThrow(UserError);
        await expect(files.downloadTarget(prisma, ctx, { fileId: secretId, inline: true })).rejects.toThrow(UserError);
        await expect(files.renameFile(prisma, ctx, { fileId: secretId, name: "x.pdf" })).rejects.toThrow(UserError);
        await expect(files.deleteFile(prisma, ctx, { fileId: secretId })).rejects.toThrow(UserError);
        await expect(files.moveFile(prisma, ctx, { fileId: secretId, folderId: folder.General! })).rejects.toThrow(UserError);
      }
    });

    it("shows it to admins and to the granted user, and audits downloads from restricted folders", async () => {
      for (const who of ["admin", "hr"] as const) {
        const ctx = await ctxFor(who);
        expect((await files.listFiles(prisma, ctx)).items.map((f) => f.id)).toContain(secretId);
        expect(await files.getFile(prisma, ctx, secretId)).not.toBeNull();
      }
      await files.downloadTarget(prisma, await ctxFor("admin"), { fileId: secretId });
      const audit = await prisma.auditLog.findFirst({ where: { action: "file.download", targetId: secretId } });
      expect(audit).toMatchObject({ userEmail: "admin@api-pharma.net" });
      await files.downloadTarget(prisma, await ctxFor("sara"), { fileId: (await upload("sara", "plain.pdf", "plain doc", folder["Sales/Quotations"])).fileId });
      expect(await prisma.auditLog.count({ where: { action: "file.download" } })).toBe(1);
    });

    it("stops showing it as soon as the grant is revoked", async () => {
      const viewerGrant = { folderId: folder.HR!, userId: ids.vic! };
      await grantAccess(prisma, { orgId, email: "t" }, { ...viewerGrant, canWrite: false });
      expect(await files.getFile(prisma, await ctxFor("vic"), secretId)).not.toBeNull();
      await revokeAccess(prisma, { orgId, email: "t" }, viewerGrant);
      expect(await files.getFile(prisma, await ctxFor("vic"), secretId)).toBeNull();
    });

    it("keeps companies apart", async () => {
      for (const who of ["admin", "sara"] as const) {
        const ctx = await ctxFor(who);
        expect((await files.listFiles(prisma, ctx)).items.map((f) => f.id)).not.toContain(secretOrg2Id);
        expect(await files.getFile(prisma, ctx, secretOrg2Id)).toBeNull();
      }
    });
  });

  describe("changing files", () => {
    it("files an unfiled file into a writable folder, and records who did", async () => {
      const done = await upload("sara", "to-file.pdf", "to file later", null);
      const ctx = await ctxFor("sara");
      await expect(files.moveFile(prisma, ctx, { fileId: done.fileId, folderId: folder.HR! })).rejects.toThrow(/cannot file into/);
      await files.moveFile(prisma, ctx, { fileId: done.fileId, folderId: folder["Sales/Quotations"]! });
      expect(await files.getFile(prisma, ctx, done.fileId)).toMatchObject({ status: "ready", filedBy: "sara@api-pharma.net", folderPath: "Sales / Quotations" });
      const audit = await prisma.auditLog.findFirst({ where: { action: "file.move", targetId: done.fileId } });
      expect(audit).toMatchObject({ before: { folderId: null }, after: { folderId: folder["Sales/Quotations"] } });
    });

    it("lets editors change only their own files; admins any; viewers none", async () => {
      const done = await upload("sara", "owned.pdf", "owned by sara", folder["Sales/Quotations"]);
      const omar = await ctxFor("omar");
      await expect(files.moveFile(prisma, omar, { fileId: done.fileId, folderId: folder.General! })).rejects.toThrow(/only move files you uploaded/);
      await expect(files.renameFile(prisma, omar, { fileId: done.fileId, name: "x.pdf" })).rejects.toThrow(/only rename/);
      await expect(files.deleteFile(prisma, omar, { fileId: done.fileId })).rejects.toThrow(/only delete/);
      const vic = await ctxFor("vic");
      await expect(files.renameFile(prisma, vic, { fileId: done.fileId, name: "x.pdf" })).rejects.toThrow(UserError);

      await files.renameFile(prisma, await ctxFor("admin"), { fileId: done.fileId, name: "عقد الإيجار.pdf" });
      expect((await files.getFile(prisma, omar, done.fileId))?.name).toBe("عقد الإيجار.pdf");
    });

    it("keeps unfiled files private to the uploader and admins", async () => {
      const done = await upload("sara", "waiting.pdf", "waiting for a folder", null);
      expect(await files.getFile(prisma, await ctxFor("omar"), done.fileId)).toBeNull();
      expect(await files.getFile(prisma, await ctxFor("admin"), done.fileId)).not.toBeNull();
      expect((await files.listUnfiled(prisma, await ctxFor("omar"))).map((f) => f.id)).not.toContain(done.fileId);
      expect((await files.listUnfiled(prisma, await ctxFor("admin"))).map((f) => f.id)).toContain(done.fileId);
    });

    it("saves details with cleaned tags and rejects a bad date", async () => {
      const done = await upload("sara", "details.pdf", "details doc", folder["Sales/Quotations"]);
      const ctx = await ctxFor("sara");
      const base = { fileId: done.fileId, title: " Quotation QT-2291 ", summary: "", docType: "quotation", docDate: "2026-03-15", tags: "Gulf Pharmacy, insulin ,INSULIN، دواء" };
      await files.updateFileDetails(prisma, ctx, base);
      expect(await files.getFile(prisma, ctx, done.fileId)).toMatchObject({
        title: "Quotation QT-2291",
        summary: null,
        docType: "quotation",
        tags: ["gulf pharmacy", "insulin", "دواء"],
      });
      await expect(files.updateFileDetails(prisma, ctx, { ...base, docDate: "2026-02-30" })).rejects.toThrow(/YYYY-MM-DD/);
      await expect(files.updateFileDetails(prisma, ctx, { ...base, docType: "memo" })).rejects.toThrow(UserError);
    });

    it("deletes softly and restores", async () => {
      const done = await upload("sara", "delete-me.pdf", "delete me", folder["Sales/Quotations"]);
      const ctx = await ctxFor("sara");
      await files.deleteFile(prisma, ctx, { fileId: done.fileId });
      expect(await files.getFile(prisma, ctx, done.fileId)).toBeNull();
      expect((await files.listDeleted(prisma, ctx)).map((f) => f.id)).toContain(done.fileId);
      expect((await files.listDeleted(prisma, await ctxFor("omar"))).map((f) => f.id)).not.toContain(done.fileId);
      await expect(files.restoreFile(prisma, await ctxFor("omar"), { fileId: done.fileId })).rejects.toThrow(UserError);

      await files.restoreFile(prisma, ctx, { fileId: done.fileId });
      expect(await files.getFile(prisma, ctx, done.fileId)).not.toBeNull();
      const actions = (await prisma.auditLog.findMany({ where: { targetId: done.fileId }, orderBy: { createdAt: "asc" } })).map((a) => a.action);
      expect(actions).toEqual(["file.upload", "file.delete", "file.restore"]);
    });

    it("will not restore a file deleted more than 30 days ago", async () => {
      const done = await upload("sara", "old.pdf", "old deleted", folder["Sales/Quotations"]);
      await prisma.storedFile.update({ where: { id: done.fileId }, data: { deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) } });
      await expect(files.restoreFile(prisma, await ctxFor("sara"), { fileId: done.fileId })).rejects.toThrow(/purged/);
    });
  });

  describe("listing", () => {
    it("sorts, pages and counts", async () => {
      const ctx = await ctxFor("admin");
      const target = folder.Marketing!;
      for (let i = 0; i < 53; i++) await upload("admin", `brochure-${String(i).padStart(2, "0")}.pdf`, `brochure content ${i}`, target);
      const page1 = await files.listFiles(prisma, ctx, { folderId: target, sort: "name" });
      expect(page1).toMatchObject({ total: 53, page: 1, pages: 2 });
      expect(page1.items).toHaveLength(50);
      expect(page1.items[0]!.name).toBe("brochure-00.pdf");
      const page2 = await files.listFiles(prisma, ctx, { folderId: target, sort: "name", page: 2 });
      expect(page2.items.map((f) => f.name)).toEqual(["brochure-50.pdf", "brochure-51.pdf", "brochure-52.pdf"]);
      const desc = await files.listFiles(prisma, ctx, { folderId: target, sort: "name", dir: "desc" });
      expect(desc.items[0]!.name).toBe("brochure-52.pdf");
    });
  });

  describe("folder administration", () => {
    const actor = () => ({ orgId, email: "admin@api-pharma.net" });

    it("creates folders, refuses duplicates and nesting that is too deep", async () => {
      const { id } = await createFolder(prisma, actor(), { name: "Tenders", nameAr: "المناقصات", description: "Tender documents.", access: "everyone", parentId: folder.Sales! });
      expect(await prisma.folder.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: "Tenders", nameAr: "المناقصات", parentId: folder.Sales });
      await expect(createFolder(prisma, actor(), { name: "tenders", nameAr: "", description: "", access: "everyone", parentId: folder.Sales! })).rejects.toThrow(/already a folder/);
      await expect(createFolder(prisma, actor(), { name: "Sales", nameAr: "", description: "", access: "everyone", parentId: null })).rejects.toThrow(/already a folder/);
      await expect(createFolder(prisma, actor(), { name: " ", nameAr: "", description: "", access: "everyone", parentId: null })).rejects.toThrow(/name/);

      let parent: string = id;
      for (const name of ["L3", "L4", "L5"]) {
        parent = (await createFolder(prisma, actor(), { name, nameAr: "", description: "", access: "everyone", parentId: parent })).id;
      }
      await expect(createFolder(prisma, actor(), { name: "L6", nameAr: "", description: "", access: "everyone", parentId: parent })).rejects.toThrow(/levels deep/);
    });

    it("moves a folder with its contents and refuses to move it into itself", async () => {
      const { id } = await createFolder(prisma, actor(), { name: "Archive", nameAr: "", description: "", access: "everyone", parentId: null });
      const child = await createFolder(prisma, actor(), { name: "2025", nameAr: "", description: "", access: "everyone", parentId: id });
      const filed = await upload("admin", "archived.pdf", "archived doc", child.id);
      await expect(updateFolder(prisma, actor(), id, { name: "Archive", nameAr: "", description: "", access: "everyone", parentId: child.id })).rejects.toThrow(/into itself/);

      await updateFolder(prisma, actor(), id, { name: "Archive", nameAr: "", description: "Old files", access: "everyone", parentId: folder.General! });
      const ctx = await ctxFor("admin");
      expect(await files.getFile(prisma, ctx, filed.fileId)).toMatchObject({ folderPath: "General / Archive / 2025" });
    });

    it("restricting a folder hides its files from people without a grant", async () => {
      const { id } = await createFolder(prisma, actor(), { name: "Board", nameAr: "", description: "", access: "everyone", parentId: null });
      const filed = await upload("admin", "minutes.pdf", "board minutes", id);
      expect(await files.getFile(prisma, await ctxFor("sara"), filed.fileId)).not.toBeNull();
      await updateFolder(prisma, actor(), id, { name: "Board", nameAr: "", description: "", access: "restricted", parentId: null });
      expect(await files.getFile(prisma, await ctxFor("sara"), filed.fileId)).toBeNull();
      expect(await files.getFile(prisma, await ctxFor("admin"), filed.fileId)).not.toBeNull();
    });

    it("deactivates a subtree, keeps its files readable, and blocks new uploads", async () => {
      const { id } = await createFolder(prisma, actor(), { name: "Old Projects", nameAr: "", description: "", access: "everyone", parentId: null });
      const sub = await createFolder(prisma, actor(), { name: "Alpha", nameAr: "", description: "", access: "everyone", parentId: id });
      const filed = await upload("admin", "alpha.pdf", "alpha project", sub.id);
      await setFolderActive(prisma, actor(), id, false);
      expect((await prisma.folder.findMany({ where: { id: { in: [id, sub.id] } } })).every((f) => !f.isActive)).toBe(true);

      const ctx = await ctxFor("sara");
      expect(await files.getFile(prisma, ctx, filed.fileId)).not.toBeNull();
      await expect(files.startUpload(prisma, ctx, { name: "n.pdf", size: 5, mimeType: "application/pdf", sha256: sha("n"), folderId: sub.id })).rejects.toThrow(/cannot upload to that folder/);

      await expect(setFolderActive(prisma, actor(), sub.id, true)).rejects.toThrow(/parent/);
      await setFolderActive(prisma, actor(), id, true);
      await setFolderActive(prisma, actor(), sub.id, true);
      expect((await ctxFor("sara")).writable.has(sub.id)).toBe(true);
    });

    it("grants only to company members", async () => {
      const stranger = await prisma.appUser.create({ data: { email: "stranger@elsewhere.example" } });
      await expect(grantAccess(prisma, actor(), { folderId: folder.HR!, userId: stranger.id, canWrite: false })).rejects.toThrow(/Add that person/);
      await expect(grantAccess(prisma, { orgId: otherOrgId, email: "t" }, { folderId: folder.HR!, userId: ids.hr!, canWrite: false })).rejects.toThrow(UserError);
    });
  });
});
