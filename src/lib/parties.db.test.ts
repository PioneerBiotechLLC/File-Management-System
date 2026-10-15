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
    getObject: async (key: string) => (stored.has(key) ? new Uint8Array([37, 80, 68, 70]) : null),
    head: async (key: string) => (stored.has(key) ? { sizeBytes: stored.get(key)!, contentType: null } : null),
    copy: async (from: string, to: string) => void stored.set(to, stored.get(from)!),
    remove: async (key: string) => void stored.delete(key),
    checkBucket: async () => undefined,
    removePrefix: async (prefix: string) => {
      const keys = [...stored.keys()].filter((k) => k.startsWith(prefix));
      for (const k of keys) stored.delete(k);
      return keys.length;
    },
  };
});

let nextFiling: Record<string, unknown> = {};
vi.mock("@/lib/analysis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analysis")>();
  return {
    ...actual,
    analyzeFile: async () => ({
      status: "analyzed",
      model: "test",
      readStatus: "full",
      analysis: { readable: true, problem: null, docDate: null, filing: nextFiling },
    }),
  };
});
vi.mock("@/lib/extract", () => ({ extract: async () => ({ kind: "text", text: "x" }) }));
vi.stubEnv("ANTHROPIC_API_KEY", "test-key");

const { createCompany } = await import("./companies");
const { refileOne, listRefileFiles } = await import("./refile");
const { addMember } = await import("./users");
const files = await import("./files");
const { destinationOf, fileTo, filingYear, listMaterials, listParties, suggestionFor } = await import("./parties");
const { browseTrading } = await import("./browse");
const { restructureFolders } = await import("./restructure");
const { resetFiles } = await import("./reset");
const { autoFileAfterRead } = await import("./bulk");
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

  it("browses by year, side, company and kind, each list narrowed by the other choices", async () => {
    const vic = await ctxFor("vic");
    const all = await browseTrading(prisma, vic);
    expect(all.active).toBe(false);
    expect(all.years).toEqual([{ value: 2026, label: "2026", count: 3 }, { value: 2025, label: "2025", count: 1 }]);
    expect(all.sides.map((s) => [s.value, s.count])).toEqual([["customer", 3], ["supplier", 1]]);
    expect(all.parties.map((p) => [p.label, p.side, p.count])).toEqual([["Gulf Pharmacy", "supplier", 1], ["Gulf Pharmacy LLC", "customer", 3]]);
    expect(all.docKinds.map((k) => [k.value, k.count])).toEqual([["quotations", 1], ["purchase_orders", 1], ["invoices", 2]]);
    expect(all).toMatchObject({ folderIds: [], total: 0 });

    // 2025 has only the supplier's purchase order, so customers, the LLC and the other kinds disappear.
    const in2025 = await browseTrading(prisma, vic, { year: "2025" });
    expect(in2025.years.map((y) => y.value)).toEqual([2026, 2025]);
    expect(in2025.sides.map((s) => s.value)).toEqual(["supplier"]);
    expect(in2025.parties.map((p) => p.label)).toEqual(["Gulf Pharmacy"]);
    expect(in2025.docKinds.map((k) => k.value)).toEqual(["purchase_orders"]);
    expect(in2025).toMatchObject({ active: true, total: 1 });

    const invoices = await browseTrading(prisma, vic, { side: "customer", docKind: "invoices", year: "nonsense" });
    expect(invoices.filter).toMatchObject({ side: "customer", docKind: "invoices", year: null });
    expect(invoices.years.map((y) => y.value)).toEqual([2026]);
    expect(invoices.total).toBe(2);
    const listed = await files.listFiles(prisma, vic, { folderIds: invoices.folderIds });
    expect(listed.items.map((f) => f.name).sort()).toEqual(["INV-1001.pdf", "INV-1002.pdf"]);
    expect(all.trees).toEqual({ trading: true, technical: false });
  });

  it("browses technical documents by manufacturer, material and kind", async () => {
    const admin = await ctxFor("admin");
    const coa = await waiting("sara", "CC-MCC-COA.pdf");
    await fileTo(prisma, admin, { fileId: coa, destination: { kind: "technical", partyId: null, partyName: "Colorcon", materialId: null, materialName: "MCC 102", docKind: "coa" } });
    const tds = await waiting("sara", "CC-MCC-TDS.pdf");
    await fileTo(prisma, admin, { fileId: tds, destination: { kind: "technical", partyId: null, partyName: "Colorcon", materialId: null, materialName: "MCC 102", docKind: "specifications" } });
    const other = await waiting("sara", "RO-LAC-COA.pdf");
    await fileTo(prisma, admin, { fileId: other, destination: { kind: "technical", partyId: null, partyName: "Roquette", materialId: null, materialName: "Lactose 200M", docKind: "coa" } });

    const vic = await ctxFor("vic");
    const all = await browseTrading(prisma, vic, { tree: "technical" });
    expect(all.trees.technical).toBe(true);
    expect(all.makers.map((m) => [m.label, m.count])).toEqual([["Colorcon", 2], ["Roquette", 1]]);
    expect(all.materials.map((m) => [m.label, m.count])).toEqual([["Lactose 200M", 1], ["MCC 102", 2]]);
    expect(all.techKinds.map((k) => [k.value, k.count])).toEqual([["coa", 2], ["specifications", 1]]);

    const signet = all.makers.find((m) => m.label === "Colorcon")!.value;
    const narrowed = await browseTrading(prisma, vic, { tree: "technical", partyId: signet, docKind: "coa" });
    expect(narrowed.materials.map((m) => m.label)).toEqual(["MCC 102"]);
    expect(narrowed.techKinds.map((k) => k.value)).toEqual(["coa", "specifications"]);
    expect(narrowed.total).toBe(1);
    expect((await files.listFiles(prisma, vic, { folderIds: narrowed.folderIds })).items.map((f) => f.name)).toEqual(["CC-MCC-COA.pdf"]);
    // A commercial kind means nothing in the technical tree, and the other way round.
    expect((await browseTrading(prisma, vic, { tree: "technical", docKind: "invoices" })).filter.docKind).toBeNull();
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
    const fresh = suggestionFor({ folderId: null, trading: { side: "supplier", partyId: null, partyName: "Noor Chemicals", docKind: "contracts" }, confidence: 0.6, reason: "r" }, ctx, parties, 2024);
    expect(fresh).toMatchObject({ newParty: true, path: "2024 / Suppliers / Noor Chemicals / Contracts" });
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

  it("files technical documents under Technical / manufacturer / material / kind, matching materials by any spelling", async () => {
    const admin = await ctxFor("admin");
    const coa = await waiting("sara", "MCC102-batch-533.pdf");
    await fileTo(prisma, admin, {
      fileId: coa,
      destination: { kind: "technical", partyId: null, partyName: "Signet Excipients Pvt. Ltd.", materialId: null, materialName: "Microcrystalline Cellulose 102", docKind: "coa" },
    });
    expect((await files.getFile(prisma, await ctxFor("admin"), coa))?.folderPath).toBe("Technical / Signet Excipients Pvt. Ltd. / Microcrystalline Cellulose 102 / Certificates of Analysis");
    const maker = (await listParties(prisma, orgId)).find((p) => p.key === "signet excipients")!;
    expect(maker.side).toBe("supplier");
    const material = (await listMaterials(prisma, orgId)).find((m) => m.name === "Microcrystalline Cellulose 102");
    expect(material).toMatchObject({ partyId: maker.id, name: "Microcrystalline Cellulose 102", key: "microcrystalline cellulose 102" });
    expect((await prisma.storedFile.findUniqueOrThrow({ where: { id: coa } })).materialId).toBe(material!.id);
    const tree = await prisma.folder.findMany({ where: { orgId, OR: [{ kind: "tech_root" }, { partyId: maker.id, kind: { in: ["tech_party", "material", "tech_doc"] } }] }, orderBy: { createdAt: "asc" } });
    expect(tree.map((f) => [f.kind, f.name])).toEqual([
      ["tech_root", "Technical"],
      ["tech_party", "Signet Excipients Pvt. Ltd."],
      ["material", "Microcrystalline Cellulose 102"],
      ["tech_doc", "Certificates of Analysis"],
    ]);
    expect(tree[0]).toMatchObject({ sortOrder: -1, parentId: null });
    expect(await prisma.auditLog.findFirst({ where: { orgId, action: "material.create", targetId: material!.id } })).toMatchObject({ after: { name: "Microcrystalline Cellulose 102", supplier: "Signet Excipients Pvt. Ltd." } });

    // Same manufacturer and material in another spelling: no new folders, and the AI's stored suggestion resolves to them.
    const sds = await waiting("sara", "MCC-102-SDS.pdf");
    const suggestion = suggestionFor(
      { folderId: null, trading: { tree: "technical", partyId: null, partyName: "SIGNET EXCIPIENTS", materialId: null, materialName: "MCC102", docKind: "sds" }, confidence: 0.9, reason: "r" },
      admin,
      await listParties(prisma, orgId),
      2026,
      await listMaterials(prisma, orgId),
    );
    expect(suggestion).toMatchObject({ newParty: false, newMaterial: true, path: "Technical / Signet Excipients Pvt. Ltd. / MCC102 / Safety Data Sheets" });
    await fileTo(prisma, admin, { fileId: sds, destination: { ...suggestion!.destination, materialName: "Microcrystalline  Cellulose 102" } as never });
    expect(await prisma.material.count({ where: { orgId, partyId: maker.id } })).toBe(1);
    expect((await files.getFile(prisma, await ctxFor("admin"), sds))?.folderPath).toBe("Technical / Signet Excipients Pvt. Ltd. / Microcrystalline Cellulose 102 / Safety Data Sheets");
    expect(destinationOf((await prisma.storedFile.findUniqueOrThrow({ where: { id: sds } })).folderId, await ctxFor("admin"), await listParties(prisma, orgId), await listMaterials(prisma, orgId))).toMatchObject({
      kind: "technical",
      materialId: material!.id,
      docKind: "sds",
    });
  });

  it("bulk upload: files a confident AI read at once, and leaves unsure or unread files for Review", async () => {
    const admin = await ctxFor("admin");
    const company = { timezone: "Asia/Dubai" };
    // What readUpload leaves behind: a draft summary and a filing proposal, nothing confirmed.
    const read = async (name: string, data: object) => {
      const fileId = await waiting("sara", name);
      await prisma.storedFile.update({ where: { id: fileId }, data: { summaryConfirmedAt: null, readStatus: "full", title: name, summary: `About ${name}`, ...data } });
      return fileId;
    };
    const sure = await read("DN-9.pdf", { docDate: new Date("2025-03-01T00:00:00Z"), suggestedTrading: { side: "supplier", partyId: null, partyName: "Maple Biotech", docKind: "delivery_notes" }, filingConfidence: 0.92, filingReason: "Delivery note from a supplier" });
    const unsure = await read("odd-note.pdf", { suggestedTrading: { side: "customer", partyId: null, partyName: "Somebody", docKind: "correspondence" }, filingConfidence: 0.3, filingReason: "Unclear" });
    const unread = await waiting("sara", "scan.pdf");
    await prisma.storedFile.update({ where: { id: unread }, data: { summaryConfirmedAt: null, readStatus: "not_read", aiError: "handwritten" } });

    expect(await autoFileAfterRead(prisma, admin, company, sure)).toMatchObject({ action: "filed", path: "2025 / Suppliers / Maple Biotech / Delivery Notes", newParty: "Maple Biotech" });
    expect(await prisma.storedFile.findUniqueOrThrow({ where: { id: sure } })).toMatchObject({ status: "ready", summaryConfirmedBy: "admin@api-pharma.net", filedBy: "admin@api-pharma.net" });
    expect(await prisma.auditLog.findFirst({ where: { targetId: sure, action: "file.summary" } })).toMatchObject({ after: { auto: true } });

    expect(await autoFileAfterRead(prisma, admin, company, unsure)).toMatchObject({ action: "review", reason: expect.stringContaining("30% sure") });
    expect(await autoFileAfterRead(prisma, admin, company, unread)).toMatchObject({ action: "review", reason: expect.stringContaining("handwritten") });
    expect(await prisma.storedFile.count({ where: { id: { in: [unsure, unread] }, status: "needs_review", summaryConfirmedAt: null } })).toBe(2);
    expect(await prisma.party.count({ where: { orgId, name: "Somebody" } })).toBe(0);
    await expect(autoFileAfterRead(prisma, await ctxFor("sara"), company, unsure)).rejects.toThrow(/Only admins/);
  });

  it("re-files a stored file by the current rules, previewing first and moving only when sure", async () => {
    const company = { name: "API Pharma", domain: "api-pharma.net", timezone: "Asia/Dubai" };
    const fileId = await waiting("sara", "RMS 0116009 Propylene Glycol.pdf");
    await fileTo(prisma, await ctxFor("sara"), {
      fileId,
      destination: { kind: "technical", partyId: null, partyName: "Julphar", materialId: null, materialName: "Propylene Glycol", docKind: "specifications" },
    });
    const admin = await ctxFor("admin");
    const wrong = "Technical / Julphar / Propylene Glycol / Specifications & Data Sheets";
    expect((await listRefileFiles(prisma, await ctxFor("admin"), "technical")).find((f) => f.id === fileId)).toMatchObject({ path: wrong });

    nextFiling = { placement: "trading", side: "customer", partyId: null, partyName: "Julphar", materialId: null, materialName: null, docKind: "specifications", folderId: null, confidence: 0.9, reason: "A customer's own specification" };
    const year = filingYear(null, new Date(), "Asia/Dubai");
    // The spec's own date (2012) does not scatter a customer's specifications across years.
    await prisma.storedFile.update({ where: { id: fileId }, data: { docDate: new Date("2012-05-01T00:00:00Z") } });
    expect(await refileOne(prisma, admin, company, fileId, { apply: false })).toMatchObject({ status: "preview", from: wrong, to: `${year} / Customers / Julphar / Specifications` });
    expect((await files.getFile(prisma, admin, fileId))?.folderId).not.toBeNull();
    expect(await listRefileFiles(prisma, await ctxFor("admin"), "technical").then((l) => l.some((f) => f.id === fileId))).toBe(true);

    nextFiling = { ...nextFiling, confidence: 0.4 };
    expect(await refileOne(prisma, admin, company, fileId, { apply: true })).toMatchObject({ status: "kept" });

    nextFiling = { ...nextFiling, confidence: 0.9 };
    expect(await refileOne(prisma, admin, company, fileId, { apply: true })).toMatchObject({ status: "moved", to: expect.stringContaining("Customers / Julphar / Specifications") });
    const moved = await prisma.storedFile.findUniqueOrThrow({ where: { id: fileId } });
    expect(moved.materialId).toBeNull();
    expect(moved.partyId).not.toBeNull();
    expect(await refileOne(prisma, await ctxFor("admin"), company, fileId, { apply: true })).toMatchObject({ status: "unchanged" });
    await expect(refileOne(prisma, await ctxFor("sara"), company, fileId, { apply: true })).rejects.toThrow(/Only admins/);
  });

  it("resets a company to before its first upload, keeping its own folders, people and log", async () => {
    const regular = await prisma.folder.count({ where: { orgId, kind: "regular" } });
    const logBefore = await prisma.auditLog.count({ where: { orgId } });
    expect(await prisma.storedFile.count({ where: { orgId } })).toBeGreaterThan(0);
    expect(await prisma.folder.count({ where: { orgId, kind: { not: "regular" } } })).toBeGreaterThan(0);

    const r = await resetFiles(prisma, orgId, "cli:test");

    expect(r.files).toBeGreaterThan(0);
    expect(r.parties).toBe(8);
    expect(await prisma.storedFile.count({ where: { orgId } })).toBe(0);
    expect(await prisma.fileVersion.count({ where: { file: { orgId } } })).toBe(0);
    expect(await prisma.party.count({ where: { orgId } })).toBe(0);
    expect(await prisma.folder.count({ where: { orgId, kind: { not: "regular" } } })).toBe(0);
    expect(await prisma.folder.count({ where: { orgId, kind: "regular" } })).toBe(regular);
    expect(await prisma.membership.count({ where: { orgId } })).toBe(4);
    expect([...stored.keys()].some((k) => k.startsWith(`${orgId}/`))).toBe(false);
    expect(await prisma.auditLog.count({ where: { orgId } })).toBe(logBefore + 1);
  });
});
