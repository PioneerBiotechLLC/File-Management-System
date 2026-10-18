import { describe, expect, it } from "vitest";
import { CSV_COLUMNS, factsCsv, type CsvFile } from "./facts-csv";

const file = (overrides: Partial<CsvFile> = {}): CsvFile => ({
  id: "f1",
  orgId: "o1",
  name: "QT-2291.pdf",
  title: 'Quotation QT-2291 – "Insulin"',
  docType: "quotation",
  docDate: new Date("2026-03-15T00:00:00Z"),
  summary: "Quotation for insulin glargine,\nto Gulf Pharmacy.",
  facts: {
    parties: ["API Pharma", "Gulf Pharmacy"],
    references: [{ kind: "quotation", value: "QT-2291" }],
    amounts: [{ value: 1250.5, currency: "AED" }],
    products: ["Insulin glargine"],
    items: [
      { description: "Insulin glargine 100 IU/ml, 3 ml pen", quantity: 500, unit: "pens", unitPrice: 2.5, total: 1250, currency: "AED" },
      { description: "Delivery", quantity: null, unit: null, unitPrice: null, total: 50.5, currency: "AED" },
    ],
    expiryDate: "2026-06-30",
  },
  tags: ["gulf pharmacy", "insulin"],
  language: "en",
  createdAt: new Date("2026-03-16T08:00:00Z"),
  summaryConfirmedAt: new Date("2026-03-16T08:05:00Z"),
  summaryConfirmedBy: "sara@api-pharma.net",
  folderId: "doc1",
  folder: { year: 2026 },
  party: { side: "customer", name: "Gulf Pharmacy" },
  material: null,
  uploader: { name: "Sara", email: "sara@api-pharma.net" },
  folderPath: "2026 / Customers / Gulf Pharmacy / Quotations",
  ...overrides,
});

const parse = (csv: string) => {
  expect(csv.startsWith("﻿")).toBe(true);
  const lines = csv.slice(1).split("\r\n").filter(Boolean);
  // A CSV reader good enough for the test: quoted cells may hold commas, quotes and line breaks.
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const text = csv.slice(1);
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") (row.push(cell), (cell = ""));
    else if (c === "\r" && text[i + 1] === "\n") (row.push(cell), rows.push(row), (row = []), (cell = ""), i++);
    else cell += c;
  }
  return { lines, rows };
};

describe("factsCsv", () => {
  it("writes one row per line item, with the file's columns repeated", () => {
    const { rows } = parse(factsCsv(file()));
    expect(rows[0]).toEqual([...CSV_COLUMNS]);
    expect(rows).toHaveLength(3);
    const first = Object.fromEntries(CSV_COLUMNS.map((c, i) => [c, rows[1]![i]]));
    expect(first).toMatchObject({
      file_id: "f1",
      file_name: "QT-2291.pdf",
      title: 'Quotation QT-2291 – "Insulin"',
      document_type: "Quotation",
      document_date: "2026-03-15",
      side: "customer",
      company: "Gulf Pharmacy",
      material: "",
      folder: "2026 / Customers / Gulf Pharmacy / Quotations",
      year: "2026",
      summary: "Quotation for insulin glargine,\nto Gulf Pharmacy.",
      parties: "API Pharma; Gulf Pharmacy",
      references: "quotation QT-2291",
      amounts: "1250.5 AED",
      expiry_date: "2026-06-30",
      tags: "gulf pharmacy; insulin",
      uploaded_by: "Sara",
      confirmed_by: "sara@api-pharma.net",
      item_no: "1",
      item_description: "Insulin glargine 100 IU/ml, 3 ml pen",
      quantity: "500",
      unit: "pens",
      unit_price: "2.5",
      line_total: "1250",
      currency: "AED",
    });
    const second = Object.fromEntries(CSV_COLUMNS.map((c, i) => [c, rows[2]![i]]));
    expect(second).toMatchObject({ file_id: "f1", item_no: "2", item_description: "Delivery", quantity: "", unit: "", unit_price: "", line_total: "50.5" });
  });

  it("quotes cells with commas, quotes and line breaks", () => {
    const csv = factsCsv(file());
    expect(csv).toContain('"Quotation QT-2291 – ""Insulin"""');
    expect(csv).toContain('"Quotation for insulin glargine,\nto Gulf Pharmacy."');
    expect(csv).toContain(",QT-2291.pdf,");
  });

  it("still writes one row for a file with no items, and blanks for what is missing", () => {
    const { rows } = parse(factsCsv(file({ facts: {}, party: null, folder: null, folderId: null, folderPath: null, docType: null, docDate: null, title: null })));
    expect(rows).toHaveLength(2);
    const only = Object.fromEntries(CSV_COLUMNS.map((c, i) => [c, rows[1]![i]]));
    expect(only).toMatchObject({ file_id: "f1", title: "", document_type: "", document_date: "", side: "", company: "", folder: "", year: "", item_no: "", item_description: "" });
  });
});
