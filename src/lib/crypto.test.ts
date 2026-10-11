import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openText, sealText } from "./crypto";

const key = randomBytes(32);

describe("sealText / openText", () => {
  it("round-trips Arabic and English text", () => {
    const text = "Quotation QT-2291 — عرض سعر للأنسولين ٢٠٢٦";
    const sealed = sealText(text, key);
    expect(sealed.startsWith("enc:v1:")).toBe(true);
    expect(sealed).not.toContain("QT-2291");
    expect(openText(sealed, key)).toBe(text);
  });

  it("uses a fresh IV each time", () => {
    expect(sealText("same", key)).not.toBe(sealText("same", key));
  });

  it("stores plain text when no key is configured", () => {
    expect(sealText("plain", null)).toBe("plain");
    expect(openText("plain", null)).toBe("plain");
  });

  it("refuses to open encrypted text without a key or with the wrong key", () => {
    const sealed = sealText("secret", key);
    expect(() => openText(sealed, null)).toThrow(/DATA_ENCRYPTION_KEY/);
    expect(() => openText(sealed, randomBytes(32))).toThrow();
  });

  it("detects tampering", () => {
    const sealed = sealText("secret", key);
    const tampered = sealed.slice(0, -4) + (sealed.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(() => openText(tampered, key)).toThrow();
  });
});
