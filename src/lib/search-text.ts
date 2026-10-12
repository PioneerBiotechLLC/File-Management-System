/**
 * Text normalisation shared by indexing and querying, so both sides agree. Pure.
 * - Letters and digits are tokens; everything else separates. "PO-4512", "PO#4512" and "PO4512"
 *   all contain the token 4512 (the last one as "po" + "4512").
 * - Arabic: digits to 0–9, diacritics and tatweel dropped, alef and ya and ta marbuta unified,
 *   and a leading definite article removed, so "الإنسولين" and "انسولين" meet.
 */

const DIACRITICS = /[ً-ٰٟـ]/g;
const EASTERN_DIGITS = /[٠-٩۰-۹]/g;
const ARTICLES = ["وال", "بال", "فال", "كال", "ال", "لل"];

/** The folded form of a text: NFKC, lowercase, Western digits, unified Arabic letters. */
export function fold(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(EASTERN_DIGITS, (d) => String(d.charCodeAt(0) & 0xf))
    .replace(DIACRITICS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");
}

function stripArticle(token: string): string {
  for (const article of ARTICLES) {
    if (token.startsWith(article) && token.length - article.length >= 3) return token.slice(article.length);
  }
  return token;
}

/** Folded tokens, in order, duplicates kept. */
export function tokenize(text: string): string[] {
  return (fold(text).match(/\p{L}+|\p{N}+/gu) ?? []).map(stripArticle);
}

const STOP = new Set(
  [
    "the", "a", "an", "of", "for", "to", "in", "on", "and", "or", "from", "with", "by", "at", "is", "are", "was", "be",
    "this", "that", "these", "those", "it", "its", "file", "files", "document", "documents", "doc", "me", "show", "find",
    "get", "all", "any", "please", "i", "we", "our", "us", "my", "about", "around", "last", "year", "want", "need", "looking",
    "في", "من", "علي", "الي", "عن", "مع", "و", "او", "هذا", "هذه", "ذلك", "هل", "ما", "ملف", "مستند", "كل", "لي", "لنا", "اريد", "ابحث",
  ].map(fold),
);

export function isStopWord(token: string): boolean {
  return STOP.has(token);
}

/** Three or more digits that are not a year: a PO, invoice, batch or phone number. */
export function isIdentifyingNumber(token: string): boolean {
  if (!/^\d{3,}$/.test(token)) return false;
  if (token.length === 4) {
    const year = Number(token);
    return year < 1900 || year > 2100;
  }
  return true;
}

/** Tokens worth indexing or searching for: no stop words, no single characters, capped. */
export function meaningfulTokens(text: string, max = 4_000): string[] {
  const out: string[] = [];
  for (const token of tokenize(text)) {
    if (token.length < 2 || STOP.has(token)) continue;
    out.push(token);
    if (out.length >= max) break;
  }
  return out;
}

/** The text handed to to_tsvector('simple', …): folded tokens only, so the index never sees raw text. */
export function indexText(parts: (string | null | undefined)[], max = 4_000): string {
  return meaningfulTokens(parts.filter((p): p is string => Boolean(p)).join(" \n "), max).join(" ");
}

const term = (token: string, prefix: boolean) => `${token}${prefix ? ":*" : ""}`;

/**
 * tsquery texts for to_tsquery('simple', …), strictest first; the caller runs them in turn until one
 * finds enough. 1: every term (as a prefix, so typing "insul" already matches). 2: the identifying
 * numbers alone. 3: any term. Empty when the query holds nothing searchable.
 */
export function queryPlans(query: string): string[] {
  const terms = [...new Set(meaningfulTokens(query, 20))];
  const fallback = [...new Set(tokenize(query).filter((t) => t.length >= 2))].slice(0, 20);
  const words = terms.length > 0 ? terms : fallback;
  if (words.length === 0) return [];
  const plans = [words.map((w) => term(w, true)).join(" & ")];
  const numbers = words.filter(isIdentifyingNumber);
  if (numbers.length > 0 && words.length > 1) plans.push(numbers.map((n) => term(n, false)).join(" & "));
  if (words.length > 1) plans.push(words.map((w) => term(w, true)).join(" | "));
  return [...new Set(plans)];
}
