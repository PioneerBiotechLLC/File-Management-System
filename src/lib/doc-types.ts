export const DOC_TYPES = [
  "quotation",
  "purchase_order",
  "invoice",
  "coa",
  "contract",
  "certificate",
  "report",
  "letter",
  "specification",
  "price_list",
  "other",
] as const;

export type DocType = (typeof DOC_TYPES)[number];

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  quotation: "Quotation",
  purchase_order: "Purchase order",
  invoice: "Invoice",
  coa: "Certificate of analysis",
  contract: "Contract",
  certificate: "Certificate",
  report: "Report",
  letter: "Letter",
  specification: "Specification",
  price_list: "Price list",
  other: "Other",
};
