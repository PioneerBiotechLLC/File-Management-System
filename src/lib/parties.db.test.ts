import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { TEST_DATABASE_URL, freshDatabase } from "@/test/database";
import { addTestFolders } from "@/test/folders";

const stored = new Map<string, number>();

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    presignUpload: async (key: string) => `https://bucket.test/put/${key}`,
    head: async (key: string) => (stored.has(key) ? { sizeBytes: stored.get(key)!, contentType: null } : null),
    copy: async (from: string, to: string) => void stored.set(to, stored.get(from)!),
    remove: async (key: string) => void stored.delete(key),
  };
});

const { createCompany } = await import("./companies");
const { addMember } = await import("./users");
const files = await import("./files");
const { destinationOf, fileTo, filingYear, listParties, suggestionFor } = await import("./parties");
const { restructureFolders } = await import("./restructure");
const { grantAccess } = await import("./folder-admin");
const { UserError } = await import("./errors");

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe.skipIf(!TEST_DATABASE_URL)("filing by year, customer and supplier (database)", () => {
  let prisma: PrismaClient;
  let drop: () => Promise<void>;
  let orgId: string;
  const ids: Record<string, string> = {};
  const ctxFor = (who: "admin" | "sara" | "omar" | "vic") =>
    files.fileContext(prisma, { orgId, userId: ids[who]!, email: `${who}@api-pharma.net`, role: who === "admin" ? "admin" : who === "vic" ? "viewer" : "editor" });

  /** An upload with a confirmed summary, waiting for its folder. */
  async function waiting(who: "sara" | "omar", name: string) {
    const ctx = await ctxFor(who);
    const started = await files.startUpload(prisma, ctx, { name, size: name.length, mimeType: "application/pdf", sha256: sha(name), allowDuplicate: true });
    if (started.kind !== "upload") throw new Error("expected an upload");
    stored.set(`${orgId}/${started.fileId}/1.upload`, name.length);
    await files.confirmUpload(prisma, ctx, { fileId: started.fileId, versionNo: 1 });
    await prisma.storedFile.update({ where: { id: started.fileId }, data: { status: "needs_review", summaryConfirmedAt: new Date() } });
    return started.fileId;
  }

  const invoiceTo = (partyName: string, partyId: string | null = null, year = 2026) =>
    ({ kind: "trading", year, side: "customer", partyId, partyName, docKind: "invoices" }) as const;

  beforeAll(async () => {
    ({ prisma, drop } = await freshDatabase());
    orgId = (await createCompany(prisma, { slug: "api-pharma", name: "API Pharma", domain: "api-pharma.net", actorEmail: "t" })).id;
    for (const [who, role] of [["admin", "admin"], ["sara", "editor"], ["omar", "editor"], ["vic", "viewer"]] as const) {
      ({ userId: ids[who]! } = await addMember(prisma, { orgId, email: `${who}@api-pharma.net`, role, actor: { email: "t" } }));
    }
  }, 60_000);

  afterAll(async () => drop?.());

  it("creates 2026 / Customers / Gulf Pharmacy / Invoices on first use, and records the customer", async () => {
    const fileId = await waiting("sara", "INV-1001.pdf");
    await fileTo(prisma, await ctxFor("sara"), { fileId, destination: invoiceTo("Gulf Pharmacy LLC") });

    const file = await files.getFile(prisma, await ctxFor("sara"), fileId);
    expect(file).toMatchObject({ folderPath: "2026 / Customers / Gulf Pharmacy LLC / Invoices", status: "ready", filedBy: "sara@api-pharma.net" });
    const [party] = await listParties(prisma, orgId);
    expect(party).toMatchObject({ side: "customer", name: "Gulf Pharmacy LLC", key: "gulf pharmacy" });
    expect((await prisma.storedFile.findUniqueOrThrow({ where: { id: fileId } })).partyId).toBe(party!.id);

    const folders = await prisma.folder.findMany({ where: { orgId, kind: { not: "regular" } }, orderBy: { createdAt: "asc" } });
    expect(folders.map((f) => [f.kind, f.name])).toEqual([
      ["year", "2026"],
      ["side", "Customers"],
      ["party", "Gulf Pharmacy LLC"],
      ["doc", "Invoices"],
    ]);
    expect(folders[0]).toMatchObject({ year: 2026, sortOrder: -2026, parentId: null });
    expect(folders[3]).toMatchObject({ year: 2026, side: "customer", partyId: party!.id, docKind: "invoices" });
    expect(await prisma.auditLog.findFirst({ where: { orgId, action: "party.create" } })).toMatchObject({ userEmail: "sara@api-pharma.net", after: { name: "Gulf Pharmacy LLC", side: "customer" } });
  });

  it("reuses the company and its folders for any spelling, and keeps suppliers apart", async () => {
    const second = await waiting("sara", "INV-1002.pdf");
    await fileTo(prisma, await ctxFor("sara"), { fileId: second, destination: invoiceTo("GULF PHARMACY L.L.C."), seenAs: "GPharm Dubai" });
    const quote = await waiting("omar", "Q-77.pdf");
    await fileTo(prisma, await ctxFor("omar"), { fileId: quote, destination: { ...invoiceTo("Gulf Pharmacy"), docKind: "quotations" } });
    const bought = await waiting("omar", "PO-5.pdf");
    await fileTo(prisma, await ctxFor("omar"), { fileId: bought, destination: { ...invoiceTo("Gulf Pharmacy"), side: "supplier", docKind: "purchase_orders", year: 2025 } });

    const parties = await listParties(prisma, orgId);
    expect(parties.map((p) => [p.side, p.name]).sort()).toEqual([
      ["customer", "Gulf Pharmacy LLC"],
      ["supplier", "Gulf Pharmacy"],
    ]);
    expect(parties.find((p) => p.side === "customer")!.aliases).toEqual(["gpharm dubai"]);
    const admin = await ctxFor("admin");
    expect((await files.getFile(prisma, admin, quote))?.folderPath).toBe("2026 / Customers / Gulf Pharmacy LLC / Quotations");
    expect((await files.getFile(prisma, admin, bought))?.folderPath).toBe("2025 / Suppliers / Gulf Pharmacy / Purchase Orders");
    expect(await prisma.folder.count({ where: { orgId, kind: "year" } })).toBe(2);
    expect(await prisma.folder.count({ where: { orgId, kind: "party", year: 2026 } })).toBe(1);
  });

  it("checks permission before creating anything", async () => {
    const fileId = await waiting("sara", "not-omars.pdf");
    const before = await prisma.party.count();
    await expect(fileTo(prisma, await ctxFor("omar"), { fileId, destination: invoiceTo("Brand New Co") })).rejects.toThrow(UserError);
    await expect(fileTo(prisma, await ctxFor("vic"), { fileId, destination: invoiceTo("Brand New Co") })).rejects.toThrow(UserError);
    expect(await prisma.party.count()).toBe(before);
    expect(await prisma.folder.count({ where: { orgId, name: "Brand New Co" } })).toBe(0);
  });

  it("refuses a missing name, an unknown party id, and a year folder an admin restricted", async () => {
    const fileId = await waiting("sara", "odd.pdf");
    const sara = await ctxFor("sara");
    await expect(fileTo(prisma, sara, { fileId, destination: invoiceTo(" ") })).rejects.toThrow(/customer's name/);
    await expect(fileTo(prisma, sara, { fileId, destination: invoiceTo("x", "no-such-id") })).rejects.toThrow(/no longer exists/);

    const y2026 = await prisma.folder.findFirstOrThrow({ where: { orgId, kind: "year", year: 2026 } });
    await prisma.folder.update({ where: { id: y2026.id }, data: { access: "restricted" } });
    await grantAccess(prisma, { orgId, email: "t" }, { folderId: y2026.id, userId: ids.sara!, canWrite: false });
    await expect(fileTo(prisma, await ctxFor("sara"), { fileId, destination: invoiceTo("Gulf Pharmacy") })).rejects.toThrow(/cannot file into/);
    await prisma.folder.update({ where: { id: y2026.id }, data: { access: "everyone" } });
  });

  it("turns a stored suggestion into a confirmable one, and reads a folder back as a destination", async () => {
    const ctx = await ctxFor("sara");
    const parties = await listParties(prisma, orgId);
    const customer = parties.find((p) => p.side === "customer")!;
    const known = suggestionFor({ folderId: null, trading: { side: "customer", partyId: null, partyName: "GPharm Dubai", docKind: "invoices" }, confidence: 0.9, reason: "r" }, ctx, parties, 2026);
    expect(known).toMatchObject({ newParty: false, path: "2026 / Customers / Gulf Pharmacy LLC / Invoices", seenAs: "GPharm Dubai", destination: { partyId: customer.id } });
    const fresh = suggestionFor({ folderId: null, trading: { side: "supplier", partyId: null, partyName: "Noor Chemicals", docKind: "coa" }, confidence: 0.6, reason: "r" }, ctx, parties, 2024);
    expect(fresh).toMatchObject({ newParty: true, path: "2024 / Suppliers / Noor Chemicals / Certificates of Analysis" });
    expect(suggestionFor({ folderId: "gone", trading: null, confidence: 1, reason: "" }, ctx, parties, 2026)).toBeNull();

    const docFolder = ctx.folders.find((f) => f.kind === "doc" && f.docKind === "invoices" && f.year === 2026)!;
    expect(destinationOf(docFolder.id, ctx, parties)).toEqual({ kind: "trading", year: 2026, side: "customer", partyId: customer.id, partyName: "Gulf Pharmacy LLC", docKind: "invoices" });
    const general = ctx.folders.find((f) => f.name === "General")!;
    expect(destinationOf(general.id, ctx, parties)).toEqual({ kind: "folder", folderId: general.id });
  });

  it("takes the year from the document's date, else the upload day in the company's time zone", () => {
    expect(filingYear(new Date("2024-12-31T00:00:00Z"), new Date("2026-05-01T00:00:00Z"), "Asia/Dubai")).toBe(2024);
    // 21:00 UTC on 31 Dec is already 1 Jan in Dubai.
    expect(filingYear(null, new Date("2025-12-31T21:00:00Z"), "Asia/Dubai")).toBe(2026);
  });

  it("moves an older company to the new tree once, keeping Bank's grants and old files", async () => {
    const old = (await createCompany(prisma, { slug: "old-co", name: "Old", domain: "old.example", actorEmail: "t" })).id;
    await addTestFolders(prisma, old);
    // The first tree had Finance / Bank and Quality / Certificates of Analysis.
    const finance = await prisma.folder.create({ data: { orgId: old, parentId: null, name: "Finance", createdBy: "t" } });
    const bank = await prisma.folder.findFirstOrThrow({ where: { orgId: old, name: "Bank", parentId: null } });
    await prisma.folder.delete({ where: { id: bank.id } });
    const oldBank = await prisma.folder.create({ data: { orgId: old, parentId: finance.id, name: "Bank", access: "restricted", createdBy: "t" } });
    const quotes = await prisma.folder.findFirstOrThrow({ where: { orgId: old, name: "Quotations" } });
    await prisma.storedFile.create({ data: { orgId: old, folderId: quotes.id, name: "a.pdf", originalName: "a.pdf", mimeType: "application/pdf", sizeBytes: 1, sha256: sha("a"), status: "ready", uploadedBy: ids.admin! } });

    const result = await restructureFolders(prisma, old, "cli:test");
    expect(result).toMatchObject({ created: 0, bankMoved: true, filesInRetired: 1 });
    expect(result.retired.sort()).toEqual(["Finance", "Logistics", "Purchasing", "Sales"]);
    expect(await prisma.folder.findUniqueOrThrow({ where: { id: oldBank.id } })).toMatchObject({ parentId: null, isActive: true, access: "restricted" });
    expect((await prisma.folder.findUniqueOrThrow({ where: { id: quotes.id } })).isActive).toBe(false);

    const again = await restructureFolders(prisma, old, "cli:test");
    expect(again).toMatchObject({ created: 0, bankMoved: false, retired: [], filesInRetired: 1 });
  });
});
