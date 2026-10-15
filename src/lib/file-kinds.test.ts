import { describe, expect, it } from "vitest";
import { DOC_TYPES } from "./doc-types";
import { DOC_KINDS, docKindForType, matchParty, partyKey, tradingPath } from "./file-kinds";

describe("partyKey", () => {
  it("ignores case, punctuation, legal forms and a leading 'the'", () => {
    for (const name of ["Gulf Pharmacy LLC", "GULF PHARMACY L.L.C.", "Gulf  Pharmacy, L.L.C", "The Gulf Pharmacy", "gulf-pharmacy fze"]) {
      expect(partyKey(name)).toBe("gulf pharmacy");
    }
    expect(partyKey("Al Noor Chemicals & Co.")).toBe("al noor chemicals");
    expect(partyKey("شركة النور للكيماويات ذ.م.م")).toBe("شركة النور للكيماويات");
  });

  it("never folds a name down to nothing", () => {
    expect(partyKey("LLC")).toBe("llc");
    expect(partyKey("  ")).toBe("");
  });
});

describe("matchParty", () => {
  const parties = [
    { id: "p1", side: "customer" as const, name: "Gulf Pharmacy", key: "gulf pharmacy", aliases: ["gpharm"] },
    { id: "p2", side: "supplier" as const, name: "Gulf Pharmacy", key: "gulf pharmacy", aliases: [] },
  ];

  it("matches on the same side by folded name or a known spelling", () => {
    expect(matchParty(parties, "customer", "GULF PHARMACY L.L.C.")?.id).toBe("p1");
    expect(matchParty(parties, "supplier", "Gulf Pharmacy")?.id).toBe("p2");
    expect(matchParty(parties, "customer", "GPharm")?.id).toBe("p1");
    expect(matchParty(parties, "customer", "Noor")).toBeNull();
  });

  it("ignores spaces, case and punctuation: ARABLAB, Arab Lab and ARAB-LAB L.L.C. are one customer", () => {
    const arab = [{ id: "a1", side: "customer" as const, name: "Arab Lab", key: "arab lab", aliases: [] }];
    for (const spelling of ["ARABLAB", "ARAB LAB", "Arab-Lab L.L.C.", "arab  lab llc", "ArabLab"]) expect(matchParty(arab, "customer", spelling)?.id).toBe("a1");
    expect(matchParty(arab, "customer", "Arab Laboratories")).toBeNull();
  });
});

describe("document kinds", () => {
  it("gives every document type a customer/supplier folder", () => {
    for (const type of DOC_TYPES) expect(DOC_KINDS.map((k) => k.id)).toContain(docKindForType(type));
    expect(docKindForType("invoice")).toBe("invoices");
    expect(docKindForType("delivery_note")).toBe("delivery_notes");
    expect(docKindForType(null)).toBe("correspondence");
  });

  it("builds the path", () => {
    expect(tradingPath({ kind: "trading", year: 2026, side: "customer", partyId: null, partyName: "Gulf Pharmacy", docKind: "invoices" })).toBe(
      "2026 / Customers / Gulf Pharmacy / Invoices",
    );
  });
});
