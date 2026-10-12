import { describe, expect, it } from "vitest";
import { fold, indexText, isIdentifyingNumber, meaningfulTokens, queryPlans, tokenize } from "./search-text";

describe("tokenize", () => {
  it("splits letters and digits so punctuation never matters", () => {
    for (const q of ["PO-4512", "PO#4512", "PO4512", "INV/2026/4512", "po 4512"]) expect(tokenize(q)).toContain("4512");
    expect(tokenize("PO4512")).toEqual(["po", "4512"]);
    expect(tokenize("Insulin 100IU/ml")).toEqual(["insulin", "100", "iu", "ml"]);
  });

  it("folds Arabic so spellings meet", () => {
    expect(tokenize("الإنسولين")).toEqual(tokenize("انسولين"));
    expect(tokenize("والشركة")).toEqual(["شركه"]);
    expect(tokenize("للمبيعات")).toEqual(["مبيعات"]);
    expect(fold("مُحَمَّد")).toBe("محمد");
    expect(fold("٢٠٢٦/٠٣/١٥ ۴۵")).toBe("2026/03/15 45");
    expect(tokenize("إلى على")).toEqual(["الي", "علي"]);
  });

  it("keeps short Arabic words whole instead of stripping an article", () => {
    expect(tokenize("الله")).toEqual(["الله"]);
  });

  it("normalises width and case", () => {
    expect(tokenize("ＱＴ－２２９１ Gulf")).toEqual(["qt", "2291", "gulf"]);
  });
});

describe("isIdentifyingNumber", () => {
  it("accepts long numbers and short ones that are not years", () => {
    expect(isIdentifyingNumber("4512")).toBe(true);
    expect(isIdentifyingNumber("2026")).toBe(false);
    expect(isIdentifyingNumber("1899")).toBe(true);
    expect(isIdentifyingNumber("123")).toBe(true);
    expect(isIdentifyingNumber("12")).toBe(false);
    expect(isIdentifyingNumber("22910")).toBe(true);
  });
});

describe("meaningfulTokens and indexText", () => {
  it("drops stop words and single characters, in both languages", () => {
    expect(meaningfulTokens("Show me the quotation for Gulf Pharmacy from 2026")).toEqual(["quotation", "gulf", "pharmacy", "2026"]);
    expect(meaningfulTokens("ابحث عن عرض السعر من شركة الخليج")).toEqual(["عرض", "سعر", "شركه", "خليج"]);
  });

  it("caps the index at the given number of tokens and skips empty parts", () => {
    expect(indexText(["a b", null, "cc dd ee"], 2)).toBe("cc dd");
  });
});

describe("queryPlans", () => {
  it("tries every term, then the numbers alone, then any term", () => {
    expect(queryPlans("insulin quotation QT-2291")).toEqual(["insulin:* & quotation:* & qt:* & 2291:*", "2291", "insulin:* | quotation:* | qt:* | 2291:*"]);
  });

  it("has one plan for one word, and prefix-matches it", () => {
    expect(queryPlans("insul")).toEqual(["insul:*"]);
    expect(queryPlans("the")).toEqual(["the:*"]);
    expect(queryPlans("?!")).toEqual([]);
  });

  it("does not repeat a plan that equals the first", () => {
    expect(queryPlans("4512")).toEqual(["4512:*"]);
    expect(queryPlans("4512 7781")).toEqual(["4512:* & 7781:*", "4512 & 7781", "4512:* | 7781:*"]);
  });
});
