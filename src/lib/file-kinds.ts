import type { DocType } from "@/lib/doc-types";

/**
 * Where a document is filed. Documents exchanged with one customer or supplier go under
 * `<year> / Customers|Suppliers / <company> / <kind>`, folders the app creates the first time
 * they are needed. Everything else goes in one of the company's own folders (HR, Quality & Regulatory…).
 * No database code here: the browser uses this too.
 */

export const SIDES = ["customer", "supplier"] as const;
export type PartySide = (typeof SIDES)[number];

export const SIDE_FOLDERS: Record<PartySide, { name: string; label: string; sortOrder: number }> = {
  customer: { name: "Customers", label: "Customer", sortOrder: 0 },
  supplier: { name: "Suppliers", label: "Supplier", sortOrder: 1 },
};

/** The folders each customer and supplier gets, in this order, created only when a document needs one. */
export const DOC_KINDS = [
  { id: "quotations", name: "Quotations", docTypes: ["quotation"] },
  { id: "purchase_orders", name: "Purchase Orders", docTypes: ["purchase_order"] },
  { id: "delivery_notes", name: "Delivery Notes", docTypes: ["delivery_note"] },
  { id: "invoices", name: "Invoices", docTypes: ["invoice"] },
  { id: "coa", name: "Certificates of Analysis", docTypes: ["coa"] },
  { id: "contracts", name: "Contracts", docTypes: ["contract"] },
  { id: "price_lists", name: "Price Lists", docTypes: ["price_list"] },
  { id: "payments", name: "Payments & Receipts", docTypes: ["payment"] },
  { id: "shipping", name: "Shipping & Customs", docTypes: ["shipping_document"] },
  { id: "correspondence", name: "Correspondence", docTypes: ["letter", "certificate", "report", "specification", "other"] },
] as const satisfies readonly { id: string; name: string; docTypes: readonly DocType[] }[];

export type DocKindId = (typeof DOC_KINDS)[number]["id"];
export const DOC_KIND_IDS = DOC_KINDS.map((k) => k.id) as [DocKindId, ...DocKindId[]];

export function docKind(id: DocKindId) {
  return DOC_KINDS.find((k) => k.id === id)!;
}

/** The customer/supplier folder a document of this type goes in. */
export function docKindForType(docType: DocType | null | undefined): DocKindId {
  return DOC_KINDS.find((k) => (k.docTypes as readonly string[]).includes(docType ?? ""))?.id ?? "correspondence";
}

/** Legal forms that do not tell two companies apart: "Gulf Pharmacy LLC" is "Gulf Pharmacy". */
const LEGAL_SUFFIXES = new Set([
  "llc", "fze", "fzco", "fzc", "fz", "fzllc", "ltd", "limited", "inc", "incorporated", "plc", "gmbh", "ag", "sa", "sarl", "bv", "nv",
  "co", "company", "corp", "corporation", "est", "establishment", "pvt", "pte", "private", "wll", "spc", "psc", "pjsc", "group",
]);

/** A display name: no control characters, single spaces, at most 100 characters. */
export function cleanPartyName(raw: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  return raw.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "").replace(/\s+/g, " ").trim().slice(0, 100);
}

/** The name folded for matching: case, punctuation, "&"/"and" and trailing legal forms do not matter. */
export function partyKey(name: string): string {
  const words = cleanPartyName(name)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\bl\.?\s?l\.?\s?c\.?/g, " llc ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  for (;;) {
    const last = words[words.length - 1]!;
    if (words.length > 1 && (LEGAL_SUFFIXES.has(last) || last === "and")) words.pop();
    // ذ.م.م is the Arabic LLC.
    else if (words.length > 3 && words.slice(-3).join(" ") === "ذ م م") words.splice(-3);
    else break;
  }
  if (words[0] === "the" && words.length > 1) words.shift();
  return words.join(" ");
}

export type PartyChoice = { id: string; side: PartySide; name: string; aliases?: string[] };

/** The key with its spaces removed: "arab lab" and "arablab" are one company. */
const compact = (key: string) => key.replace(/ /g, "");

/**
 * The existing party this name means: by its folded name or a spelling seen before, else by the
 * same letters with spaces ignored, so ARABLAB, Arab Lab and ARAB LAB L.L.C. are one customer.
 */
export function matchParty<P extends { side: PartySide; key?: string; name: string; aliases?: string[] }>(parties: P[], side: PartySide, name: string): P | null {
  const key = partyKey(name);
  if (!key) return null;
  const onSide = parties.filter((p) => p.side === side);
  const exact = onSide.find((p) => (p.key ?? partyKey(p.name)) === key || (p.aliases ?? []).includes(key));
  if (exact) return exact;
  const flat = compact(key);
  return onSide.find((p) => compact(p.key ?? partyKey(p.name)) === flat || (p.aliases ?? []).some((a) => compact(a) === flat)) ?? null;
}

export type Destination =
  | { kind: "folder"; folderId: string }
  | { kind: "trading"; year: number; side: PartySide; partyId: string | null; partyName: string; docKind: DocKindId };

/** "2026 / Customers / Gulf Pharmacy / Invoices". */
export function tradingPath(d: Extract<Destination, { kind: "trading" }>): string {
  return [String(d.year), SIDE_FOLDERS[d.side].name, d.partyName, docKind(d.docKind).name].join(" / ");
}

/** What the AI (or the stored suggestion) proposes, ready to show and to file with. */
export type FilingSuggestion = {
  destination: Destination;
  path: string;
  /** A customer or supplier that has no folder yet. */
  newParty: boolean;
  /** The company's name as the document prints it, when it differs from the existing party's. */
  seenAs: string | null;
  confidence: number;
  reason: string;
};

/** Years offered when filing: next year back to 2000. */
export function filingYears(now = new Date()): number[] {
  const current = now.getFullYear();
  return Array.from({ length: current + 2 - 2000 }, (_, i) => current + 1 - i);
}
