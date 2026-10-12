/**
 * Rules for names and types of uploaded files. These run on the server; the browser only
 * pre-checks the same rules to save a round trip.
 */

/** Executables and scripts are never stored. */
const BLOCKED_EXTENSIONS = new Set([
  "exe", "msi", "bat", "cmd", "com", "scr", "pif", "dll", "cpl", "lnk", "reg", "hta", "jar", "apk", "app", "dmg",
  "sh", "bash", "zsh", "ps1", "psm1", "vbs", "vbe", "js", "jse", "mjs", "wsf", "wsh", "py", "rb", "pl", "php",
]);

const MAX_NAME_LENGTH = 200;

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * A safe display name: no folder path, no control or bidi-override characters, at most 200
 * characters with the extension kept. Arabic and other scripts are untouched.
 */
export function cleanFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "file";
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned;
  const ext = extensionOf(cleaned);
  const keep = ext && ext.length <= 10 ? `.${ext}` : "";
  return cleaned.slice(0, MAX_NAME_LENGTH - keep.length) + keep;
}

export function isBlockedFile(name: string, mimeType: string): boolean {
  if (BLOCKED_EXTENSIONS.has(extensionOf(name))) return true;
  return /^application\/(x-msdownload|x-msdos-program|x-sh|x-executable|x-dosexec|vnd\.microsoft\.portable-executable)/i.test(mimeType);
}

/** The media type used for the upload and for later downloads; anything malformed becomes octet-stream. */
export function normalizeMimeType(raw: string): string {
  const type = raw.split(";")[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(type) ? type : "application/octet-stream";
}

/** Types a browser can show inline. The type is forced on the preview URL, so a wrong claim cannot become HTML. */
type PreviewKind = "pdf" | "image";

export function previewKind(mimeType: string): PreviewKind | null {
  if (mimeType === "application/pdf") return "pdf";
  return /^image\/(png|jpeg|gif|webp)$/.test(mimeType) ? "image" : null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
