import { describe, expect, it } from "vitest";
import { contentDisposition, objectKey } from "./storage";

describe("objectKey", () => {
  it("is org, file and version, never the file name", () => {
    expect(objectKey("org_1", "cmabc123", 1)).toBe("org_1/cmabc123/1");
    expect(objectKey("org_1", "cmabc123", 12)).toBe("org_1/cmabc123/12");
  });

  it("rejects ids that could escape the prefix", () => {
    expect(() => objectKey("../x", "f", 1)).toThrow();
    expect(() => objectKey("o", "a/b", 1)).toThrow();
    expect(() => objectKey("o", "", 1)).toThrow();
  });

  it("rejects invalid version numbers", () => {
    expect(() => objectKey("o", "f", 0)).toThrow();
    expect(() => objectKey("o", "f", 1.5)).toThrow();
  });
});

describe("contentDisposition", () => {
  it("encodes Arabic names as UTF-8", () => {
    expect(contentDisposition("attachment", "عقد الإيجار.pdf")).toBe(
      "attachment; filename*=UTF-8''%D8%B9%D9%82%D8%AF%20%D8%A7%D9%84%D8%A5%D9%8A%D8%AC%D8%A7%D8%B1.pdf",
    );
  });

  it("escapes characters that RFC 5987 reserves", () => {
    expect(contentDisposition("inline", "PO (draft) 'v2'*.pdf")).toBe(
      "inline; filename*=UTF-8''PO%20%28draft%29%20%27v2%27%2A.pdf",
    );
  });

  it("cannot be broken by quotes or semicolons in the name", () => {
    expect(contentDisposition("attachment", 'a";b.pdf')).toBe("attachment; filename*=UTF-8''a%22%3Bb.pdf");
  });
});
