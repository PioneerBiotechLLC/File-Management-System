import { crc32 } from "node:zlib";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { cellText, decodeText, detectFileKind, extract } from "./extract";

const bytes = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));
const PDF = bytes("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const WEBP = bytes("RIFF\x00\x00\x00\x00WEBPVP8 ");

/** A minimal stored (uncompressed) zip, enough for mammoth to open a .docx. */
function zip(files: Record<string, string>): Uint8Array {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8");
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += header.length + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, ...central, end]));
}

function docx(paragraphs: string[]): Uint8Array {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join("");
  return zip({
    "[Content_Types].xml":
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels":
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  });
}

async function xlsx(build: (wb: ExcelJS.Workbook) => void): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

describe("detectFileKind", () => {
  it("trusts the bytes over the name and the browser's type", () => {
    expect(detectFileKind(PDF, "scan.jpg", "image/jpeg")).toEqual({ kind: "pdf" });
    expect(detectFileKind(PNG, "photo.pdf", "application/pdf")).toEqual({ kind: "image", mediaType: "image/png" });
    expect(detectFileKind(JPEG, "IMG_0001", "")).toEqual({ kind: "image", mediaType: "image/jpeg" });
    expect(detectFileKind(WEBP, "x.webp", "image/webp")).toEqual({ kind: "image", mediaType: "image/webp" });
  });

  it("finds a PDF header after leading junk", () => {
    expect(detectFileKind(bytes("\r\n  %PDF-1.4"), "a.pdf", "")).toEqual({ kind: "pdf" });
  });

  it("routes zip-based Office files by extension or type", () => {
    const z = zip({ "a.txt": "x" });
    expect(detectFileKind(z, "Offer.DOCX", "")).toEqual({ kind: "word" });
    expect(detectFileKind(z, "prices.xlsx", "application/octet-stream")).toEqual({ kind: "spreadsheet" });
    expect(detectFileKind(z, "upload", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toEqual({
      kind: "spreadsheet",
    });
    expect(detectFileKind(z, "archive.zip", "application/zip")).toEqual({ kind: "other", label: "zip" });
    expect(detectFileKind(z, "deck.pptx", "")).toEqual({ kind: "other", label: "pptx" });
  });

  it("recognises text by extension or type, but not binary content", () => {
    expect(detectFileKind(bytes("a,b\n1,2"), "list.csv", "")).toEqual({ kind: "text" });
    expect(detectFileKind(bytes("hello"), "notes", "text/plain; charset=utf-8")).toEqual({ kind: "text" });
    expect(detectFileKind(new Uint8Array([0x41, 0, 0x42]), "data.txt", "text/plain")).toEqual({ kind: "other", label: "txt" });
  });

  it("leaves everything else unread", () => {
    expect(detectFileKind(bytes("MZ\x90\x00"), "video.mp4", "video/mp4")).toEqual({ kind: "other", label: "mp4" });
    expect(detectFileKind(bytes("\xd0\xcf\x11\xe0"), "old.doc", "application/msword")).toEqual({ kind: "other", label: "doc" });
  });
});

describe("decodeText", () => {
  it("decodes UTF-8 Arabic and strips the BOM", () => {
    expect(decodeText(new Uint8Array(Buffer.from("﻿عقد الإيجار", "utf8")))).toBe("عقد الإيجار");
  });

  it("decodes UTF-16 with a BOM", () => {
    expect(decodeText(new Uint8Array([0xff, 0xfe, ...Buffer.from("PO 4512", "utf16le")]))).toBe("PO 4512");
  });

  it("falls back to Windows Arabic for legacy files", () => {
    // "عقد" in windows-1256.
    expect(decodeText(new Uint8Array([0xda, 0xde, 0xcf]))).toBe("عقد");
  });
});

describe("cellText", () => {
  it("flattens every exceljs value shape", () => {
    expect(cellText(null)).toBe("");
    expect(cellText(12.5)).toBe("12.5");
    expect(cellText(new Date("2026-03-15T00:00:00Z"))).toBe("2026-03-15");
    expect(cellText({ richText: [{ text: "Insulin " }, { text: "100IU" }] })).toBe("Insulin 100IU");
    expect(cellText({ formula: "A1*2", result: 42 })).toBe("42");
    expect(cellText({ text: "site", hyperlink: "https://example.com" })).toBe("site");
    expect(cellText({ error: "#DIV/0!" })).toBe("#DIV/0!");
  });
});

describe("extract", () => {
  it("sends PDFs to Claude as a document block", async () => {
    const out = await extract(PDF, "coa.pdf", "application/pdf");
    expect(out.kind).toBe("blocks");
    if (out.kind !== "blocks") return;
    expect(out.blocks[0]).toMatchObject({ type: "document", source: { type: "base64", media_type: "application/pdf" } });
  });

  it("sends images with the media type of their actual bytes", async () => {
    const out = await extract(JPEG, "photo.png", "image/png");
    expect(out.kind === "blocks" && out.blocks[0]).toMatchObject({ type: "image", source: { media_type: "image/jpeg" } });
  });

  it("does not read images over the API limit", async () => {
    const big = new Uint8Array(8 * 1024 * 1024);
    big.set(PNG);
    expect(await extract(big, "huge.png", "image/png")).toMatchObject({ kind: "unreadable", readStatus: "not_read" });
  });

  it("converts Word documents to text", async () => {
    const out = await extract(docx(["Quotation QT-2291", "عرض سعر"]), "offer.docx", "");
    expect(out).toMatchObject({ kind: "text", readStatus: "full" });
    expect(out.kind === "text" && out.text).toContain("QT-2291");
    expect(out.kind === "text" && out.text).toContain("عرض سعر");
  });

  it("converts spreadsheets to CSV per sheet", async () => {
    const file = await xlsx((wb) => {
      const prices = wb.addWorksheet("Prices");
      prices.addRow(["Product", "Price, AED", "Updated"]);
      prices.addRow(["Insulin \"Glargine\"", 120.5, new Date("2026-03-01T00:00:00Z")]);
      wb.addWorksheet("Notes").addRow(["Valid until June"]);
    });
    const out = await extract(file, "prices.xlsx", "");
    expect(out.kind).toBe("text");
    if (out.kind !== "text") return;
    expect(out.readStatus).toBe("full");
    expect(out.text).toBe(
      '## Sheet: Prices\nProduct,"Price, AED",Updated\n"Insulin ""Glargine""",120.5,2026-03-01\n\n## Sheet: Notes\nValid until June',
    );
  });

  it("marks long spreadsheets as partially read", async () => {
    const file = await xlsx((wb) => {
      const sheet = wb.addWorksheet("Batches");
      for (let i = 0; i < 250; i++) sheet.addRow([`B${i}`, i]);
    });
    const out = await extract(file, "batches.xlsx", "");
    expect(out).toMatchObject({ kind: "text", readStatus: "partial" });
    expect(out.kind === "text" && out.text.split("\n").length).toBe(201);
  });

  it("marks long text as partially read and keeps the beginning", async () => {
    const out = await extract(bytes("PO-4512 " + "x".repeat(150_000)), "log.txt", "text/plain");
    expect(out).toMatchObject({ kind: "text", readStatus: "partial" });
    expect(out.kind === "text" && out.text.startsWith("PO-4512")).toBe(true);
    expect(out.kind === "text" && out.text.length).toBeGreaterThan(20_000);
  });

  it("stores damaged Office files without reading them", async () => {
    expect(await extract(zip({ "junk.txt": "x" }), "broken.docx", "")).toMatchObject({ kind: "unreadable" });
    expect(await extract(zip({ "junk.txt": "x" }), "broken.xlsx", "")).toMatchObject({ kind: "unreadable" });
  });

  it("stores other files without reading them", async () => {
    expect(await extract(bytes("PK\x03\x04"), "drawings.zip", "application/zip")).toEqual({
      kind: "unreadable",
      readStatus: "not_read",
      reason: "ZIP files are stored but not read",
    });
  });
});
