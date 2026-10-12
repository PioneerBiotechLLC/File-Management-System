import type { DocType } from "@/lib/doc-types";

/**
 * The answers to "What is this file?" when uploading. Each one files into a default folder,
 * matched by its English path, and sets the document type. A company that renamed or removed
 * the folder simply does not see that answer; "Choose a folder" always remains.
 */
const FILE_KINDS: { id: string; label: string; group: string; path: string; docType: DocType }[] = [
  { id: "sales-quotation", group: "Sales", label: "Quotation we sent to a customer", path: "Sales / Quotations", docType: "quotation" },
  { id: "customer-po", group: "Sales", label: "Purchase order from a customer", path: "Sales / Customer Purchase Orders", docType: "purchase_order" },
  { id: "price-list", group: "Sales", label: "Our price list", path: "Sales / Price Lists", docType: "price_list" },
  { id: "customer-letter", group: "Sales", label: "Letter or email with a customer", path: "Sales / Customer Correspondence", docType: "letter" },

  { id: "supplier-quotation", group: "Purchasing", label: "Quotation from a supplier", path: "Purchasing / Supplier Quotations", docType: "quotation" },
  { id: "our-po", group: "Purchasing", label: "Purchase order we sent to a supplier", path: "Purchasing / Purchase Orders", docType: "purchase_order" },
  { id: "supplier-invoice", group: "Purchasing", label: "Invoice from a supplier", path: "Purchasing / Supplier Invoices", docType: "invoice" },

  { id: "coa", group: "Quality & Regulatory", label: "Certificate of analysis (COA)", path: "Quality & Regulatory / Certificates of Analysis", docType: "coa" },
  { id: "gmp", group: "Quality & Regulatory", label: "GMP certificate, licence or ISO certificate", path: "Quality & Regulatory / GMP & Licences", docType: "certificate" },
  { id: "dossier", group: "Quality & Regulatory", label: "Registration dossier or approval", path: "Quality & Regulatory / Registration Dossiers", docType: "report" },
  { id: "sop", group: "Quality & Regulatory", label: "SOP or work instruction", path: "Quality & Regulatory / SOPs", docType: "specification" },

  { id: "shipping", group: "Logistics", label: "Shipping document (bill of lading, packing list…)", path: "Logistics / Shipping Documents", docType: "other" },
  { id: "customs", group: "Logistics", label: "Customs document", path: "Logistics / Customs", docType: "other" },
  { id: "delivery", group: "Logistics", label: "Delivery note or proof of delivery", path: "Logistics / Delivery Notes", docType: "other" },

  { id: "our-invoice", group: "Finance", label: "Invoice we issued to a customer", path: "Finance / Invoices Issued", docType: "invoice" },
  { id: "payment", group: "Finance", label: "Payment, receipt or cheque", path: "Finance / Payments & Receipts", docType: "other" },
  { id: "bank", group: "Finance", label: "Bank statement, LC or guarantee", path: "Finance / Bank", docType: "other" },

  { id: "employment-contract", group: "HR", label: "Employment contract or offer letter", path: "HR / Contracts", docType: "contract" },
  { id: "employee-record", group: "HR", label: "Employee record (ID, visa, payslip…)", path: "HR / Personnel", docType: "other" },
  { id: "hr-policy", group: "HR", label: "HR policy or circular", path: "HR / Policies", docType: "other" },

  { id: "agreement", group: "Legal", label: "Contract or agreement with a company", path: "Legal / Contracts & Agreements", docType: "contract" },
  { id: "company-document", group: "Legal", label: "Company document (trade licence, POA…)", path: "Legal / Company Documents", docType: "certificate" },

  { id: "brochure", group: "Marketing", label: "Brochure, leaflet or catalogue", path: "Marketing / Brochures", docType: "other" },
  { id: "presentation", group: "Marketing", label: "Presentation", path: "Marketing / Presentations", docType: "other" },

  { id: "general", group: "Other", label: "Something else", path: "General", docType: "other" },
];

export type FileKind = { id: string; label: string; group: string; folderId: string; docType: DocType };

/** The answers this person can use: only those whose folder exists, is active and accepts their uploads. */
export function fileKindsFor(paths: Map<string, string>, writable: Set<string>): FileKind[] {
  const folderByPath = new Map<string, string>();
  for (const [id, path] of paths) if (writable.has(id)) folderByPath.set(path.toLowerCase(), id);
  return FILE_KINDS.flatMap((kind) => {
    const folderId = folderByPath.get(kind.path.toLowerCase());
    return folderId ? [{ id: kind.id, label: kind.label, group: kind.group, folderId, docType: kind.docType }] : [];
  });
}
