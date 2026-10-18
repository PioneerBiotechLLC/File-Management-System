/**
 * Plain text from an HTML file (a web page, or an email saved as HTML), for the AI to read. Markup,
 * scripts and styles are dropped; blocks, list items and table cells keep their shape so a priced
 * table still reads as rows. No DOM: the file is untrusted, and regexes cannot run anything in it.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  yen: "¥",
  deg: "°",
  times: "×",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Elements whose end starts a new line; list items and table rows only at the end, so rows do not come out double-spaced. */
const BLOCK_END = /<\/(?:p|div|h[1-6]|tr|table|thead|tbody|tfoot|blockquote|section|article|header|footer|nav|aside|address|pre|dd|dt|figcaption|caption|form|fieldset|legend|details|summary|main|ul|ol|dl)\s*>/gi;
const BLOCK_START = /<(?:p|div|h[1-6]|table|blockquote|section|article|header|footer|pre|ul|ol|dl)(?:\s[^>]*)?>/gi;

export function htmlToText(html: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  let text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    // Leading whitespace in the source means nothing; only the tags below make lines.
    .replace(/\s+/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n")
    .replace(/<li(?:\s[^>]*)?>/gi, "\n- ")
    .replace(/<\/t[dh]\s*>/gi, " | ")
    .replace(BLOCK_START, "\n")
    .replace(BLOCK_END, "\n")
    .replace(/<[^>]+>/g, "");
  text = decodeEntities(text)
    .replace(/ /g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim().replace(/( \|)+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const heading = title ? decodeEntities(title).replace(/\s+/g, " ").trim() : "";
  return heading && !text.startsWith(heading) ? `${heading}\n\n${text}` : text;
}

/** The charset a page declares in its first bytes, if a decoder exists for it. */
export function declaredCharset(bytes: Uint8Array): string | null {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const name = head.match(/charset\s*=\s*["']?\s*([\w-]+)/i)?.[1]?.toLowerCase();
  if (!name || /^utf-?8$/.test(name) || /^utf-?16/.test(name)) return null;
  try {
    new TextDecoder(name);
    return name;
  } catch {
    return null;
  }
}
