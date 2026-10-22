import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { EmailAttachmentInput } from "@/lib/email-attachments";
import { TEST_DATABASE_URL, freshDatabase } from "@/test/database";
import { addTestFolders } from "@/test/folders";

// readUpload only calls the (mocked) analysis when a key is configured.
process.env.ANTHROPIC_API_KEY ||= "test-key";

const stored = new Map<string, Uint8Array>();
const analyzeFile = vi.fn();

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    presignUpload: async (key: string) => `https://bucket.test/put/${key}`,
    head: async (key: string) => (stored.has(key) ? { sizeBytes: stored.get(key)!.length, contentType: null } : null),
    getObject: async (key: string) => stored.get(key) ?? null,
    copy: async (from: string, to: string) => {
      stored.set(to, stored.get(from)!);
    },
    remove: async (key: string) => {
      stored.delete(key);
    },
    putObject: async () => undefined,
  };
});
vi.mock("@/lib/analysis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analysis")>();
  return { ...actual, analyzeFile: (...args: unknown[]) => analyzeFile(...args) };
});

const { createCompany } = await import("./companies");
const { UserError } = await import("./errors");
const ea = await import("./email-attachments");

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const email = (over: Partial<EmailAttachmentInput["email"]> = {}) => ({
  messageId: "<po-4512@gulf.ae>", subject: "PO-4512 Amoxicillin", from: "ali@gulf.ae", to: ["sales@api-pharma.net"], direction: "inbound" as const,
  at: "2026-10-18T10:05:00.000Z", mailbox: "sales@api-pharma.net", trackerUrl: "https://tracker.test/c/api-pharma/threads/t1#msg-m1", ...over,
});

const filing = (folderId: string, confidence: number) => ({
  placement: "folder" as const, side: null, partyId: null, partyName: null, materialId: null, materialName: null, docKind: null, folderId, confidence, reason: "Test",
});

describe.skipIf(!TEST_DATABASE_URL)("email attachments from the tracker (database)", () => {
  let prisma: PrismaClient;
  let drop: () => Promise<void>;
  let orgId: string;
  const folder: Record<string, string> = {};
  const company = { name: "API Pharma", domain: "api-pharma.net", timezone: "Asia/Dubai" };

  beforeAll(async () => {
    ({ prisma, drop } = await freshDatabase());
    orgId = (await createCompany(prisma, { slug: "api-pharma", name: company.name, domain: company.domain, actorEmail: "t" })).id;
    await addTestFolders(prisma, orgId);
    for (const f of await prisma.folder.findMany({ where: { orgId }, include: { parent: true } })) folder[f.parent ? `${f.parent.name}/${f.name}` : f.name] = f.id;
  }, 60_000);
  afterAll(async () => {
    await drop();
  });

  it("refuses an unknown company and a bad body", async () => {
    await expect(ea.startEmailAttachment(prisma, { company: "nobody", file: { name: "a.pdf", mimeType: "application/pdf", size: 3, sha256: sha("a") }, email: email() })).rejects.toBeInstanceOf(ea.UnknownCompanyError);
    await expect(ea.startEmailAttachment(prisma, { company: "api-pharma", file: { name: "a.pdf", mimeType: "application/pdf", size: 0, sha256: "x" }, email: email() })).rejects.toThrow();
    await expect(ea.startEmailAttachment(prisma, { company: "api-pharma", file: { name: "setup.exe", mimeType: "application/octet-stream", size: 3, sha256: sha("a") }, email: email() })).rejects.toBeInstanceOf(UserError);
  });

  it("stores the attachment under the company's system user, reads it and files it like a bulk upload", async () => {
    const content = "PO-4512 for 5,000 bottles";
    const started = await ea.startEmailAttachment(prisma, { company: "api-pharma", file: { name: "PO-4512.pdf", mimeType: "application/pdf", size: content.length, sha256: sha(content) }, email: email() });
    expect(started.kind).toBe("upload");
    if (started.kind !== "upload") return;
    expect(started.uploadUrl).toBe(`https://bucket.test/put/${orgId}/${started.fileId}/1.upload`);

    const system = await prisma.appUser.findUniqueOrThrow({ where: { email: "email-tracker@api-pharma.net" }, include: { memberships: true } });
    expect(system.isActive).toBe(false);
    expect(system.memberships).toMatchObject([{ orgId, role: "editor" }]);
    const row = await prisma.storedFile.findUniqueOrThrow({ where: { id: started.fileId } });
    expect(row).toMatchObject({ source: "email_attachment", sourceRef: "email:<po-4512@gulf.ae>", status: "uploading", uploadedBy: system.id });
    const logged = await prisma.auditLog.findFirst({ where: { targetId: started.fileId, action: "file.email_attachment" } });
    expect(logged?.after).toMatchObject({ subject: "PO-4512 Amoxicillin", from: "ali@gulf.ae", mailbox: "sales@api-pharma.net" });

    // The tracker PUTs the bytes, then confirms.
    stored.set(`${orgId}/${started.fileId}/1.upload`, new TextEncoder().encode(content));
    const confirmed = await ea.confirmEmailAttachment(prisma, { company: "api-pharma", fileId: started.fileId, versionNo: 1 });
    expect(confirmed.status).toBe("processing");

    analyzeFile.mockResolvedValueOnce({
      status: "analyzed", readStatus: "full", model: "m",
      analysis: { readable: true, problem: null, title: "PO-4512", summary: "A purchase order.", docType: "purchase_order", docDate: null, language: "en", facts: { parties: [], references: [], amounts: [], products: [] }, tags: [], filing: filing(folder["Purchasing/Purchase Orders"]!, 0.9) },
    });
    const outcome = await ea.processEmailAttachment(prisma, { id: orgId, slug: "api-pharma", ...company }, started.fileId);
    expect(outcome.read).toEqual({ status: "read" });
    expect(outcome.filing).toMatchObject({ action: "filed", path: "Purchasing / Purchase Orders" });
    const filed = await prisma.storedFile.findUniqueOrThrow({ where: { id: started.fileId } });
    expect(filed.folderId).toBe(folder["Purchasing/Purchase Orders"]);
    expect(filed.status).toBe("ready");
    expect(filed.summaryConfirmedBy).toBe("email-tracker@api-pharma.net");
    // The read ran as the system user, so (through callClaude, mocked away here) it counts against the caps like anyone's.
    expect(analyzeFile).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ orgId, userId: system.id, fileId: started.fileId }), expect.objectContaining({ fileName: "PO-4512.pdf" }));

    // The same bytes sent again (a colleague was Cc'd) are reported as the existing file.
    const again = await ea.startEmailAttachment(prisma, { company: "api-pharma", file: { name: "PO-4512 (1).pdf", mimeType: "application/pdf", size: content.length, sha256: sha(content) }, email: email({ messageId: "<copy@gulf.ae>" }) });
    expect(again).toMatchObject({ kind: "duplicate", fileId: started.fileId, name: "PO-4512.pdf", folderPath: "Purchasing / Purchase Orders" });
  });

  it("puts a file the AI was unsure about in General, marked unsure", async () => {
    const content = "unclear scan";
    const started = await ea.startEmailAttachment(prisma, { company: "api-pharma", file: { name: "scan.pdf", mimeType: "application/pdf", size: content.length, sha256: sha(content) }, email: email({ messageId: "<scan@x>" }) });
    if (started.kind !== "upload") throw new Error("expected an upload");
    stored.set(`${orgId}/${started.fileId}/1.upload`, new TextEncoder().encode(content));
    await ea.confirmEmailAttachment(prisma, { company: "api-pharma", fileId: started.fileId, versionNo: 1 });
    analyzeFile.mockResolvedValueOnce({
      status: "analyzed", readStatus: "full", model: "m",
      analysis: { readable: true, problem: null, title: "Scan", summary: "Something.", docType: "other", docDate: null, language: "en", facts: { parties: [], references: [], amounts: [], products: [] }, tags: [], filing: filing(folder["Sales/Quotations"]!, 0.2) },
    });
    const outcome = await ea.processEmailAttachment(prisma, { id: orgId, slug: "api-pharma", ...company }, started.fileId);
    expect(outcome.filing).toMatchObject({ action: "filed", path: "General", unsure: true });
    const row = await prisma.storedFile.findUniqueOrThrow({ where: { id: started.fileId } });
    expect(row).toMatchObject({ status: "ready", folderId: folder.General, unsure: true });
  });

  it("after its own file, reads the attachments confirmed while it was busy", async () => {
    const ids: string[] = [];
    for (const [name, content] of [["DN-1.pdf", "delivery note one"], ["DN-2.pdf", "delivery note two"]] as const) {
      const started = await ea.startEmailAttachment(prisma, { company: "api-pharma", file: { name, mimeType: "application/pdf", size: content.length, sha256: sha(content) }, email: email({ messageId: `<${name}@gulf.ae>` }) });
      if (started.kind !== "upload") throw new Error("expected an upload");
      stored.set(`${orgId}/${started.fileId}/1.upload`, new TextEncoder().encode(content));
      await ea.confirmEmailAttachment(prisma, { company: "api-pharma", fileId: started.fileId, versionNo: 1 });
      ids.push(started.fileId);
    }
    for (const title of ["DN-1", "DN-2"]) {
      analyzeFile.mockResolvedValueOnce({
        status: "analyzed", readStatus: "full", model: "m",
        analysis: { readable: true, problem: null, title, summary: "A delivery note.", docType: "other", docDate: null, language: "en", facts: { parties: [], references: [], amounts: [], products: [] }, tags: [], filing: filing(folder["Logistics/Delivery Notes"]!, 0.9) },
      });
    }
    const outcome = await ea.processEmailAttachment(prisma, { id: orgId, slug: "api-pharma", ...company }, ids[0]!);
    expect(outcome.filing).toMatchObject({ action: "filed", path: "Logistics / Delivery Notes" });
    expect(await prisma.storedFile.findMany({ where: { id: { in: ids } }, select: { status: true, title: true }, orderBy: { title: "asc" } })).toEqual([{ status: "ready", title: "DN-1" }, { status: "ready", title: "DN-2" }]);
    const system = await prisma.appUser.findUniqueOrThrow({ where: { email: "email-tracker@api-pharma.net" } });
    expect(await ea.nextWaiting(prisma, { orgId, userId: system.id })).toBeNull();
  });

  it("confirming a file that is not an email attachment, or twice, is refused or harmless", async () => {
    await expect(ea.confirmEmailAttachment(prisma, { company: "api-pharma", fileId: "nope", versionNo: 1 })).rejects.toBeInstanceOf(UserError);
    const file = await prisma.storedFile.findFirstOrThrow({ where: { orgId, sourceRef: "email:<scan@x>" } });
    expect((await ea.confirmEmailAttachment(prisma, { company: "api-pharma", fileId: file.id, versionNo: 1 })).status).toBe("ready");
  });
});
