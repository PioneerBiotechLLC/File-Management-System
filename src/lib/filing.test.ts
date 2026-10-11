import { describe, expect, it } from "vitest";
import { decideFiling, type FilingInput } from "./filing";

const base: FilingInput = {
  userFolderId: null,
  uploaderEmail: "sara@api-pharma.net",
  suggestion: { folderId: "quotes", confidence: 0.9 },
  threshold: 0.75,
  aiLimitReached: false,
};

describe("decideFiling", () => {
  it("files automatically at or above the threshold", () => {
    expect(decideFiling(base)).toEqual({ status: "ready", folderId: "quotes", filedBy: "ai" });
    expect(decideFiling({ ...base, suggestion: { folderId: "quotes", confidence: 0.75 } })).toEqual({
      status: "ready",
      folderId: "quotes",
      filedBy: "ai",
    });
  });

  it("sends low-confidence files to review without a folder", () => {
    expect(decideFiling({ ...base, suggestion: { folderId: "quotes", confidence: 0.74 } })).toEqual({
      status: "needs_review",
      folderId: null,
      filedBy: null,
    });
  });

  it("sends files to review when there is no usable suggestion", () => {
    expect(decideFiling({ ...base, suggestion: { folderId: null, confidence: 0 } }).status).toBe("needs_review");
    expect(decideFiling({ ...base, suggestion: null }).status).toBe("needs_review");
  });

  it("keeps the uploader's folder and only records the AI's suggestion", () => {
    expect(decideFiling({ ...base, userFolderId: "contracts" })).toEqual({
      status: "ready",
      folderId: "contracts",
      filedBy: "sara@api-pharma.net",
    });
    expect(decideFiling({ ...base, userFolderId: "contracts", suggestion: null }).folderId).toBe("contracts");
  });

  it("needs review when the AI limit was reached, keeping a picked folder", () => {
    expect(decideFiling({ ...base, suggestion: null, aiLimitReached: true })).toEqual({
      status: "needs_review",
      folderId: null,
      filedBy: null,
    });
    expect(decideFiling({ ...base, userFolderId: "contracts", suggestion: null, aiLimitReached: true })).toEqual({
      status: "needs_review",
      folderId: "contracts",
      filedBy: "sara@api-pharma.net",
    });
  });

  it("respects a stricter threshold", () => {
    expect(decideFiling({ ...base, threshold: 0.95 }).status).toBe("needs_review");
  });
});
