import type Anthropic from "@anthropic-ai/sdk";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import WordExtractor from "word-extractor";
import { TextWriter, Uint8ArrayReader, ZipReader, configure } from "@zip.js/zip.js";
import { declaredCharset, decodeEntities, htmlToText } from "@/lib/html-text";

// No workers on the server; the slides of a .pptx are small and inflate in-process.
configure({ useWebWorkers: false });

/**
 * Turns an uploaded file into something Claude can read, in memory only: nothing produced here is
 * stored. PDFs and images go to Claude as document and image blocks (Claude reads scans and photos
 * natively). Word, Excel, CSV and plain text become text here. Anything else is stored but not read.
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
/** Spreadsheets unpack to many times their size in memory while they are parsed; larger ones take the function down with them. */
const SPREADSHEET_MAX_BYTES = 5 * 1024 * 1024;
/** What an Office file may unpack to. A real 20 MB document unpacks to a few times that; a zip bomb to gigabytes. */
const OFFICE_MAX_INFLATED_BYTES = 200 * 1024 * 1024;
const OFFICE_MAX_ENTRIES = 10_000;
/** Opening a document that takes longer than this is given up, well inside the route's own limit. */
const OFFICE_PARSE_TIMEOUT_MS = 30_000;
/** Text sent to Claude (~25k–50k tokens). Longer files are read from the start and marked partial. */
const AI_TEXT_MAX_CHARS = 100_000;
const SHEET_MAX_ROWS = 200;
const SHEET_MAX_COLUMNS = 40;

type FileKind =
  | { kind: "pdf" }
  | { kind: "image"; mediaType: ImageMediaType }
  | { kind: "word" }
  /** Word 97–2003 (.doc), the binary format mammoth cannot read. */
  | { kind: "word97" }
  | { kind: "spreadsheet" }
  | { kind: "presentation" }
  | { kind: "text" }
  /** A web page or an email saved as HTML: read as text once the markup is stripped. */
  | { kind: "html" }
  | { kind: "other"; label: string };

export type Extraction =
  | { kind: "blocks"; blocks: [DocumentBlock | ImageBlock]; readStatus: "full" }
  | { kind: "text"; text: string; readStatus: "full" | "partial" }
  | { kind: "unreadable"; readStatus: "not_read"; reason: string };

const TEXT_EXTENSIONS = new Set(["txt", "csv", "tsv", "md", "markdown", "json", "xml", "log", "ini", "yaml", "yml"]);
const HTML_EXTENSIONS = new Set(["html", "htm", "xhtml"]);
const WORD_EXTENSIONS = new Set(["docx", "docm"]);
/** .wbk is Word's automatic backup copy of a .doc, in the same format. */
const WORD97_EXTENSIONS = new Set(["doc", "dot", "wbk"]);
const SPREADSHEET_EXTENSIONS = new Set(["xlsx", "xlsm"]);
const PRESENTATION_EXTENSIONS = new Set(["pptx", "pptm", "ppsx"]);
const PRESENTATION_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
]);
/** Slides read from a deck; a longer one is read in part. */
const SLIDES_MAX = 200;
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
/** The OLE container of Office 97–2003 files (.doc, .xls, .ppt). */
const isOle = (bytes: Uint8Array) => startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/**
 * What a zip archive would unpack to, read from its central directory without inflating anything.
 * Null when the directory cannot be read (damaged, or zip64, which Office does not write at these sizes).
 */
export function zipInflatedSize(bytes: Uint8Array): { total: number; entries: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record sits in the last 64 KB, after a comment of up to 65,535 bytes.
  const earliest = Math.max(0, bytes.length - 65_557);
  let end = -1;
  for (let i = bytes.length - 22; i >= earliest; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const entries = view.getUint16(end + 10, true);
  let position = view.getUint32(end + 16, true);
  if (entries === 0xffff || position === 0xffffffff) return null;
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (position + 46 > bytes.length || view.getUint32(position, true) !== 0x02014b50) return null;
    const uncompressed = view.getUint32(position + 24, true);
    if (uncompressed === 0xffffffff) return null;
    total += uncompressed;
    position += 46 + view.getUint16(position + 28, true) + view.getUint16(position + 30, true) + view.getUint16(position + 32, true);
  }
  return { total, entries };
}

/** Refuses an Office file that would unpack to too much, before any of it is inflated. */
function officeTooBig(bytes: Uint8Array, what: string): Extraction | null {
  if (bytes.length > OFFICE_MAX_BYTES) return unreadable(`${what} is larger than ${mb(OFFICE_MAX_BYTES)}`);
  const inflated = zipInflatedSize(bytes);
  if (!inflated) return unreadable(`${what} could not be opened (damaged)`);
  if (inflated.total > OFFICE_MAX_INFLATED_BYTES || inflated.entries > OFFICE_MAX_ENTRIES) {
    return unreadable(`${what} unpacks to more than ${mb(OFFICE_MAX_INFLATED_BYTES)}, too much to read`);
  }
  return null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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
    if (PRESENTATION_EXTENSIONS.has(ext) || PRESENTATION_MIMES.has(mime)) return { kind: "presentation" };
    return { kind: "other", label: ext || "zip" };
  }
  if (isOle(bytes)) return WORD97_EXTENSIONS.has(ext) || mime === "application/msword" ? { kind: "word97" } : { kind: "other", label: ext || "ole" };
  if (looksBinary(bytes)) return { kind: "other", label: ext || mime || "unknown" };
  if (HTML_EXTENSIONS.has(ext) || mime === "text/html" || mime === "application/xhtml+xml" || looksHtml(bytes)) return { kind: "html" };
  const textual =
    TEXT_EXTENSIONS.has(ext) || mime.startsWith("text/") || mime === "application/json" || mime === "application/xml";
  if (textual) return { kind: "text" };
  return { kind: "other", label: ext || mime || "unknown" };
}

/** A page saved under another name: the file starts with a doctype or an html tag. */
function looksHtml(bytes: Uint8Array): boolean {
  return /^\s*(?:\uFEFF)?\s*<(?:!doctype html|html)[\s>]/i.test(new TextDecoder("latin1").decode(bytes.subarray(0, 256)));
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

/** The text of each slide, in order: paragraphs are `<a:p>`, their text runs `<a:t>`. */
async function presentationText(bytes: Uint8Array): Promise<{ text: string; truncated: boolean }> {
  const reader = new ZipReader(new Uint8ArrayReader(bytes));
  try {
    const number = (name: string) => Number(name.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
    const slides = (await reader.getEntries())
      .filter((e): e is Extract<typeof e, { directory: false }> => !e.directory && /^ppt\/slides\/slide\d+\.xml$/.test(e.filename))
      .sort((a, b) => number(a.filename) - number(b.filename));
    const parts: string[] = [];
    for (const slide of slides.slice(0, SLIDES_MAX)) {
      const xml = await slide.getData(new TextWriter());
      const paragraphs = [...xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)]
        .map((p) => decodeEntities([...p[0].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((t) => t[1]).join("")).trim())
        .filter(Boolean);
      parts.push(`## Slide ${number(slide.filename)}\n${paragraphs.join("\n")}`);
    }
    return { text: parts.join("\n\n"), truncated: slides.length > SLIDES_MAX };
  } finally {
    await reader.close();
  }
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
      const tooBig = officeTooBig(bytes, "Word file");
      if (tooBig) return tooBig;
      try {
        const { value } = await withTimeout(mammoth.extractRawText({ buffer: Buffer.from(bytes) }), OFFICE_PARSE_TIMEOUT_MS);
        if (!value.trim()) return unreadable("Word file has no text");
        return { kind: "text", ...capText(value) };
      } catch {
        return unreadable("Word file could not be opened (damaged or password-protected)");
      }
    }
    case "word97": {
      if (bytes.length > OFFICE_MAX_BYTES) return unreadable(`Word file is larger than ${mb(OFFICE_MAX_BYTES)}`);
      try {
        const doc = await withTimeout(new WordExtractor().extract(Buffer.from(bytes)), OFFICE_PARSE_TIMEOUT_MS);
        // Forms are often laid out in text boxes, which are not part of the body.
        const text = doc.getBody().trim() || doc.getTextboxes().trim();
        if (!text) return unreadable("Word file has no text");
        return { kind: "text", ...capText(text) };
      } catch {
        return unreadable("Word file could not be opened (damaged or password-protected)");
      }
    }
    case "presentation": {
      const tooBig = officeTooBig(bytes, "Presentation");
      if (tooBig) return tooBig;
      try {
        const { text, truncated } = await withTimeout(presentationText(bytes), OFFICE_PARSE_TIMEOUT_MS);
        if (!text.replace(/## Slide \d+\n?/g, "").trim()) return unreadable("Presentation has no text");
        const capped = capText(text);
        return { kind: "text", text: capped.text, readStatus: truncated ? "partial" : capped.readStatus };
      } catch {
        return unreadable("Presentation could not be opened (damaged or password-protected)");
      }
    }
    case "spreadsheet": {
      if (bytes.length > SPREADSHEET_MAX_BYTES) return unreadable(`Spreadsheet is larger than ${mb(SPREADSHEET_MAX_BYTES)}, the most that can be read`);
      const tooBig = officeTooBig(bytes, "Spreadsheet");
      if (tooBig) return tooBig;
      try {
        const { text, truncated } = await withTimeout(spreadsheetText(bytes), OFFICE_PARSE_TIMEOUT_MS);
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
    case "html": {
      const charset = declaredCharset(bytes);
      const text = htmlToText(charset ? new TextDecoder(charset).decode(bytes) : decodeText(bytes));
      if (!text) return unreadable("Web page has no text");
      return { kind: "text", ...capText(text) };
    }
    case "other":
      return unreadable(`${kind.label.toUpperCase()} files are stored but not read`);
  }
}
