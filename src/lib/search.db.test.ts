import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { TEST_DATABASE_URL, freshDatabase } from "@/test/database";
import { createCompany } from "./companies";
import { UserError } from "./errors";
import { fileContext } from "./files";
import { grantAccess } from "./folder-admin";
import { indexTextFor, reindexAll, reindexFile } from "./search-index";
import { logSearch, searchFiles, type SearchFilters } from "./search";
import { addMember } from "./users";

describe.skipIf(!TEST_DATABASE_URL)("search (database)", () => {
  let prisma: PrismaClient;
  let drop: () => Promise<void>;
  let orgId: string;
  let otherOrgId: string;
  const ids: Record<string, string> = {};
  const folder: Record<string, string> = {};
  const file: Record<string, string> = {};

  const ctxFor = (who: "admin" | "sara" | "vic" | "hr") =>
    fileContext(prisma, { orgId, userId: ids[who]!, email: `${who}@api-pharma.net`, role: who === "admin" ? "admin" : who === "vic" ? "viewer" : "editor" });

  async function seed(key: string, data: { name: string; folderId: string | null; title?: string; summary?: string; docType?: string; docDate?: string; facts?: object; tags?: string[]; uploadedBy?: string; orgId?: string }) {
    const row = await prisma.storedFile.create({
      data: {
        orgId: data.orgId ?? orgId,
        folderId: data.folderId,
        name: data.name,
        originalName: data.name,
        mimeType: "application/pdf",
        sizeBytes: 100,
        sha256: key.padEnd(64, "0"),
        status: data.folderId ? "ready" : "needs_review",
        uploadedBy: data.uploadedBy ?? ids.sara!,
        title: data.title ?? null,
        summary: data.summary ?? null,
        docType: data.docType ?? null,
        docDate: data.docDate ? new Date(`${data.docDate}T00:00:00Z`) : null,
        facts: data.facts ?? {},
        tags: data.tags ?? [],
      },
    });
    file[key] = row.id;
    await reindexFile(prisma, row.id);
  }

  beforeAll(async () => {
    ({ prisma, drop } = await freshDatabase());
    orgId = (await createCompany(prisma, { slug: "api-pharma", name: "API Pharma", domain: "api-pharma.net", actorEmail: "t" })).id;
    otherOrgId = (await createCompany(prisma, { slug: "beta-co", name: "Beta", domain: "beta.example", actorEmail: "t" })).id;
    for (const [who, role] of [["admin", "admin"], ["sara", "editor"], ["vic", "viewer"], ["hr", "editor"]] as const) {
      ({ userId: ids[who]! } = await addMember(prisma, { orgId, email: `${who}@api-pharma.net`, role, actor: { email: "t" } }));
    }
    for (const f of await prisma.folder.findMany({ where: { orgId }, include: { parent: true } })) {
      folder[f.parent ? `${f.parent.name}/${f.name}` : f.name] = f.id;
    }
    await grantAccess(prisma, { orgId, email: "t" }, { folderId: folder.HR!, userId: ids.hr!, canWrite: true });

    await seed("quote", {
      name: "QT-2291.pdf",
      folderId: folder["Sales/Quotations"]!,
      title: "Quotation QT-2291 – Insulin glargine for Gulf Pharmacy",
      summary: "Quotation from API Pharma to Gulf Pharmacy LLC for insulin glargine, total 41,500 AED, valid 30 days.",
      docType: "quotation",
      docDate: "2026-03-15",
      facts: { parties: ["API Pharma", "Gulf Pharmacy LLC"], references: [{ kind: "quotation", value: "QT-2291" }], amounts: [{ value: 41500, currency: "AED" }], products: ["Insulin glargine 100 IU/ml"] },
      tags: ["gulf pharmacy", "insulin"],
    });
    await seed("po", {
      name: "PO-4512.pdf",
      folderId: folder["Purchasing/Purchase Orders"]!,
      title: "Purchase order PO-4512 to Al Noor Chemicals",
      summary: "أمر شراء إلى شركة النور للكيماويات لتوريد الإنسولين بقيمة 12,000 دولار.",
      docType: "purchase_order",
      docDate: "2025-11-02",
      facts: { parties: ["API Pharma", "Al Noor Chemicals"], references: [{ kind: "purchase_order", value: "PO-4512" }], amounts: [{ value: 12000, currency: "USD" }], products: ["Insulin"] },
    });
    await seed("salary", {
      name: "salary-review.pdf",
      folderId: folder["HR/Personnel"]!,
      title: "Salary review 2026",
      summary: "Salary review for all staff, insulin team included.",
      docType: "report",
      uploadedBy: ids.hr!,
    });
    await seed("unfiled", { name: "scan-insulin.pdf", folderId: null, summary: "Scan of an insulin leaflet, not filed yet.", uploadedBy: ids.sara! });
    await seed("beta", { name: "beta-insulin.pdf", folderId: null, summary: "Insulin price list of another company.", orgId: otherOrgId, uploadedBy: ids.admin! });
  }, 60_000);

  afterAll(async () => drop?.());

  it("indexes the name, summary, facts, type and date as folded tokens", () => {
    const text = indexTextFor({
      name: "QT-2291.pdf",
      title: "Quotation",
      summary: "الإنسولين",
      docType: "purchase_order",
      docDate: new Date("2026-03-15T00:00:00Z"),
      facts: { amounts: [{ value: 41500, currency: "AED" }], references: [{ kind: "lot", value: "B-77" }] },
      tags: ["Gulf"],
    });
    expect(text.split(" ")).toEqual(["qt", "2291", "pdf", "quotation", "انسولين", "purchase", "order", "2026", "03", "15", "2026", "march", "lot", "77", "41500", "aed", "gulf"]);
  });

  it("finds by any spelling of a number, by Arabic or English words, and by prefix", async () => {
    const ctx = await ctxFor("sara");
    for (const q of ["PO-4512", "po#4512", "4512", "PO4512"]) {
      expect((await searchFiles(prisma, ctx, { q })).hits.map((h) => h.id)).toContain(file.po);
    }
    expect((await searchFiles(prisma, ctx, { q: "النور" })).hits.map((h) => h.id)).toEqual([file.po]);
    expect((await searchFiles(prisma, ctx, { q: "انسولين" })).hits.map((h) => h.id)).toEqual([file.po]);
    expect((await searchFiles(prisma, ctx, { q: "insul" })).hits.length).toBeGreaterThanOrEqual(2);
    expect((await searchFiles(prisma, ctx, { q: "march 2026 quotation" })).hits[0]?.id).toBe(file.quote);
  });

  it("falls back from every term to the numbers, then to any term", async () => {
    const ctx = await ctxFor("sara");
    const strict = await searchFiles(prisma, ctx, { q: "insulin quotation gulf" });
    expect(strict).toMatchObject({ plan: 1 });
    expect(strict.hits[0]?.id).toBe(file.quote);
    const numbers = await searchFiles(prisma, ctx, { q: "zzzz 4512" });
    expect(numbers).toMatchObject({ plan: 2 });
    expect(numbers.hits.map((h) => h.id)).toEqual([file.po]);
    const any = await searchFiles(prisma, ctx, { q: "zzzz noor" });
    expect(any).toMatchObject({ plan: 2 });
    expect(any.hits.map((h) => h.id)).toEqual([file.po]);
    expect(await searchFiles(prisma, ctx, { q: "zzzz" })).toMatchObject({ hits: [], plan: 1 });
  });

  it("highlights the match and returns the facts", async () => {
    const ctx = await ctxFor("sara");
    const [hit] = (await searchFiles(prisma, ctx, { q: "gulf pharmacy" })).hits;
    expect(hit?.snippet).toContain("«Gulf» «Pharmacy»");
    expect(hit?.facts.amounts).toEqual([{ value: 41500, currency: "AED" }]);
    expect(hit).toMatchObject({ folderPath: "Sales / Quotations", uploader: "sara@api-pharma.net" });
  });

  it("filters by folder (with subfolders), type, date and amount range", async () => {
    const ctx = await ctxFor("sara");
    const by = async (filters: Parameters<typeof searchFiles>[2]["filters"], q = "insulin") => (await searchFiles(prisma, ctx, { q, filters })).hits.map((h) => h.id);
    expect(await by({ folderId: folder.Sales! })).toEqual([file.quote]);
    expect(await by({ folderId: folder.Purchasing! })).toEqual([file.po]);
    expect(await by({ docType: "purchase_order" })).toEqual([file.po]);
    expect(await by({ dateFrom: "2026-01-01" })).toEqual([file.quote]);
    expect(await by({ dateTo: "2025-12-31" })).toEqual([file.po]);
    expect(await by({ amountMin: 32000, amountMax: 48000 })).toEqual([file.quote]);
    expect(await by({ amountMin: 32000, amountMax: 48000, currency: "USD" })).toEqual([]);
    expect(await by({ currency: "usd" })).toEqual([file.po]);
    // Filters alone list the newest matching files.
    expect(await by({ docType: "quotation" }, "")).toEqual([file.quote]);
    await expect(searchFiles(prisma, ctx, { q: "x", filters: { dateFrom: "yesterday" } })).rejects.toThrow(UserError);
  });

  it("never returns a file the user may not see: restricted folders, other people's unfiled files, other companies", async () => {
    for (const who of ["sara", "vic"] as const) {
      const hits = (await searchFiles(prisma, await ctxFor(who), { q: "insulin" })).hits.map((h) => h.id);
      expect(hits).not.toContain(file.salary);
      expect(hits).not.toContain(file.beta);
      if (who === "vic") expect(hits).not.toContain(file.unfiled);
    }
    const sara = (await searchFiles(prisma, await ctxFor("sara"), { q: "insulin" })).hits.map((h) => h.id);
    expect(sara).toContain(file.unfiled);
    for (const who of ["admin", "hr"] as const) {
      expect((await searchFiles(prisma, await ctxFor(who), { q: "salary" })).hits.map((h) => h.id)).toEqual([file.salary]);
    }
    expect((await searchFiles(prisma, await ctxFor("vic"), { q: "salary" })).hits).toEqual([]);
    // A name search cannot get round it either.
    expect((await searchFiles(prisma, await ctxFor("vic"), { q: "salary-review" })).hits).toEqual([]);
  });

  it("rebuilds every entry on demand", async () => {
    await prisma.$executeRaw`UPDATE "StoredFile" SET "searchVector" = NULL`;
    expect((await searchFiles(prisma, await ctxFor("sara"), { q: "النور" })).hits).toEqual([]);
    expect(await reindexAll(prisma, orgId)).toBe(4);
    expect((await searchFiles(prisma, await ctxFor("sara"), { q: "النور" })).hits.map((h) => h.id)).toEqual([file.po]);
  });

  it("logs a search once while the person keeps typing it, never shortened, with only known filters", async () => {
    const ctx = await ctxFor("sara");
    await logSearch(prisma, ctx, { q: "ins", hits: 3 });
    await logSearch(prisma, ctx, { q: "insul", hits: 3 });
    await logSearch(prisma, ctx, { q: "insulin gulf", hits: 1, filters: { docType: "quotation", pad: "x".repeat(500), nested: { a: 1 } } as SearchFilters });
    // Backspacing to a prefix does not rewrite the longer entry.
    await logSearch(prisma, ctx, { q: "insulin", hits: 3 });
    await logSearch(prisma, ctx, { q: "noor", hits: 1 });
    const rows = await prisma.auditLog.findMany({ where: { orgId, action: "search.instant" }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.after)).toEqual([
      { query: "insulin gulf", hits: 1, filters: { docType: "quotation" } },
      { query: "noor", hits: 1 },
    ]);
    expect(rows[0]).toMatchObject({ userEmail: "sara@api-pharma.net", targetId: ids.sara });
  });
});
