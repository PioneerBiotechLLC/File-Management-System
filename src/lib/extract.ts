import type Anthropic from "@anthropic-ai/sdk";
import ExcelJS from "exceljs";
import mammoth from "mammoth";

/**
 * Turns an uploaded file into something Claude can read.
 * PDFs and images go to Claude as document and image blocks (Claude reads scans and photos natively).
 * Word, Excel, CSV and plain text become text here. Anything else is stored but not read.
 */

type DocumentBlock = Anthropic.Beta.Messages.BetaRequestDocumentBlock;
type ImageBlock = Anthropic.Beta.Messages.BetaImageBlockParam;
type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/**
 * Limits from https://platform.claude.com/docs/en/build-with-claude/pdf-support and .../vision
 * (checked 2026-10-11): a request is at most 32 MB, a PDF at most 600 pages, an image at most 10 MB
 * base64-encoded. Base64 adds a third, so these are the largest raw files that fit.
 */
const PDF_MAX_BYTES = 22 * 1024 * 1024;
const IMAGE_MAX_BYTES = 7 * 1024 * 1024;
/** Office files are zip archives; unpacking a large one can exhaust a serverless function's memory. */
const OFFICE_MAX_BYTES = 20 * 1024 * 1024;
/** Text sent to Claude (~25k–50k tokens). Longer files are read from the start and marked partial. */
const AI_TEXT_MAX_CHARS = 100_000;
const SHEET_MAX_ROWS = 200;
const SHEET_MAX_COLUMNS = 40;

/** Plain text kept per file for search. */
export const SEARCH_TEXT_MAX_CHARS = 20_000;

type FileKind =
  | { kind: "pdf" }
  | { kind: "image"; mediaType: ImageMediaType }
  | { kind: "word" }
  | { kind: "spreadsheet" }
  | { kind: "text" }
  | { kind: "other"; label: string };

export type Extraction =
  /** Claude reads the blocks and transcribes the text for search. */
  | { kind: "blocks"; blocks: [DocumentBlock | ImageBlock]; readStatus: "full" }
  | { kind: "text"; text: string; readStatus: "full" | "partial" }
  | { kind: "unreadable"; readStatus: "not_read"; reason: string };

const TEXT_EXTENSIONS = new Set(["txt", "csv", "tsv", "md", "markdown", "json", "xml", "html", "htm", "log", "ini", "yaml", "yml"]);
const WORD_EXTENSIONS = new Set(["docx", "docm"]);
const SPREADSHEET_EXTENSIONS = new Set(["xlsx", "xlsm"]);
const WORD_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const SPREADSHEET_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((b, i) => bytes[offset + i] === b);
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

function sniffImage(bytes: Uint8Array): ImageMediaType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "image/gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  return null;
}

/** PDF readers accept the header anywhere in the first kilobyte. */
function isPdf(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  return head.includes("%PDF-");
}

const isZip = (bytes: Uint8Array) => startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);

/**
 * Decides how to read a file from its bytes first, because names and browser-reported types are
 * unreliable and Claude rejects a block whose declared media type does not match its content.
 */
export function detectFileKind(bytes: Uint8Array, name: string, mimeType: string): FileKind {
  if (isPdf(bytes)) return { kind: "pdf" };
  const image = sniffImage(bytes);
  if (image) return { kind: "image", mediaType: image };

  const ext = extensionOf(name);
  const mime = mimeType.toLowerCase().split(";")[0]!.trim();
  if (isZip(bytes)) {
    if (WORD_EXTENSIONS.has(ext) || mime === WORD_MIME) return { kind: "word" };
    if (SPREADSHEET_EXTENSIONS.has(ext) || mime === SPREADSHEET_MIME) return { kind: "spreadsheet" };
    return { kind: "other", label: ext || "zip" };
  }
  const textual =
    TEXT_EXTENSIONS.has(ext) || mime.startsWith("text/") || mime === "application/json" || mime === "application/xml";
  if (textual && !looksBinary(bytes)) return { kind: "text" };
  return { kind: "other", label: ext || mime || "unknown" };
}

function looksBinary(bytes: Uint8Array): boolean {
  if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) return false; // UTF-16 BOM
  return bytes.subarray(0, 8192).includes(0);
}

/** UTF-8 (with or without BOM) or UTF-16 with a BOM; anything else is taken as Windows Arabic (1256). */
export function decodeText(bytes: Uint8Array): string {
  if (startsWith(bytes, [0xff, 0xfe])) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (startsWith(bytes, [0xfe, 0xff])) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1256").decode(bytes);
  }
}

function capText(text: string): { text: string; readStatus: "full" | "partial" } {
  const clean = text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return clean.length > AI_TEXT_MAX_CHARS
    ? { text: clean.slice(0, AI_TEXT_MAX_CHARS), readStatus: "partial" }
    : { text: clean, readStatus: "full" };
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Plain text for one cell, whatever exceljs returns (formulas, rich text, links, dates, errors). */
export function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== "object") return String(value);
  if ("richText" in value) return value.richText.map((r) => r.text).join("");
  if ("formula" in value || "sharedFormula" in value) return cellText((value.result ?? null) as ExcelJS.CellValue);
  if ("text" in value) return String(value.text);
  if ("error" in value) return String(value.error);
  return "";
}

async function spreadsheetText(bytes: Uint8Array): Promise<{ text: string; truncated: boolean }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  let truncated = false;
  const sheets: string[] = [];
  workbook.eachSheet((sheet) => {
    const lines: string[] = [];
    const lastRow = sheet.actualRowCount > 0 ? sheet.rowCount : 0;
    for (let r = 1; r <= Math.min(lastRow, SHEET_MAX_ROWS); r++) {
      const row = sheet.getRow(r);
      const cells: string[] = [];
      for (let c = 1; c <= Math.min(row.cellCount, SHEET_MAX_COLUMNS); c++) {
        cells.push(csvCell(cellText(row.getCell(c).value).trim()));
      }
      if (cells.some((cell) => cell !== "")) lines.push(cells.join(",").replace(/,+$/, ""));
    }
    if (lastRow > SHEET_MAX_ROWS || sheet.columnCount > SHEET_MAX_COLUMNS) truncated = true;
    sheets.push(`## Sheet: ${sheet.name}\n${lines.join("\n")}`);
  });
  return { text: sheets.join("\n\n"), truncated };
}

function unreadable(reason: string): Extraction {
  return { kind: "unreadable", readStatus: "not_read", reason };
}

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

export async function extract(bytes: Uint8Array, name: string, mimeType: string): Promise<Extraction> {
  const kind = detectFileKind(bytes, name, mimeType);
  const data = () => Buffer.from(bytes).toString("base64");

  switch (kind.kind) {
    case "pdf":
      if (bytes.length > PDF_MAX_BYTES) return unreadable(`PDF is larger than ${mb(PDF_MAX_BYTES)}, the most Claude can read in one request`);
      return {
        kind: "blocks",
        readStatus: "full",
        blocks: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: data() } }],
      };
    case "image":
      if (bytes.length > IMAGE_MAX_BYTES) return unreadable(`Image is larger than ${mb(IMAGE_MAX_BYTES)}, the most Claude can read`);
      return {
        kind: "blocks",
        readStatus: "full",
        blocks: [{ type: "image", source: { type: "base64", media_type: kind.mediaType, data: data() } }],
      };
    case "word": {
      if (bytes.length > OFFICE_MAX_BYTES) return unreadable(`Word file is larger than ${mb(OFFICE_MAX_BYTES)}`);
      try {
        const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
        if (!value.trim()) return unreadable("Word file has no text");
        return { kind: "text", ...capText(value) };
      } catch {
        return unreadable("Word file could not be opened (damaged or password-protected)");
      }
    }
    case "spreadsheet": {
      if (bytes.length > OFFICE_MAX_BYTES) return unreadable(`Spreadsheet is larger than ${mb(OFFICE_MAX_BYTES)}`);
      try {
        const { text, truncated } = await spreadsheetText(bytes);
        if (!text.replace(/## Sheet: .*\n?/g, "").trim()) return unreadable("Spreadsheet has no data");
        const capped = capText(text);
        return { kind: "text", text: capped.text, readStatus: truncated ? "partial" : capped.readStatus };
      } catch {
        return unreadable("Spreadsheet could not be opened (damaged or password-protected)");
      }
    }
    case "text": {
      const text = decodeText(bytes);
      if (!text.trim()) return unreadable("File is empty");
      return { kind: "text", ...capText(text) };
    }
    case "other":
      return unreadable(`${kind.label.toUpperCase()} files are stored but not read`);
  }
}
