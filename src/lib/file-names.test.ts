import { describe, expect, it } from "vitest";
import { cleanFileName, extensionOf, formatBytes, isBlockedFile, normalizeMimeType, previewKind } from "./file-names";

describe("cleanFileName", () => {
  it("drops any folder path", () => {
    expect(cleanFileName("C:\\Users\\sara\\Quote QT-2291.pdf")).toBe("Quote QT-2291.pdf");
    expect(cleanFileName("../../etc/passwd")).toBe("passwd");
  });

  it("keeps Arabic names and spaces intact", () => {
    expect(cleanFileName("  عقد   الإيجار 2026.pdf ")).toBe("عقد الإيجار 2026.pdf");
  });

  it("removes control and direction-override characters", () => {
    expect(cleanFileName("invoice\u202Efdp.exe\u0000")).toBe("invoicefdp.exe");
  });

  it("never returns an empty name", () => {
    expect(cleanFileName("")).toBe("file");
    expect(cleanFileName("..")).toBe("file");
    expect(cleanFileName("///")).toBe("file");
  });

  it("truncates long names but keeps the extension", () => {
    const out = cleanFileName(`${"a".repeat(400)}.pdf`);
    expect(out).toHaveLength(200);
    expect(out.endsWith(".pdf")).toBe(true);
  });
});

describe("isBlockedFile", () => {
  it("blocks executables and scripts by extension, any case", () => {
    for (const name of ["setup.EXE", "run.sh", "x.ps1", "macro.js", "a.bat", "tool.py"]) {
      expect(isBlockedFile(name, "application/octet-stream")).toBe(true);
    }
  });

  it("blocks executable media types whatever the name", () => {
    expect(isBlockedFile("report.pdf", "application/x-msdownload")).toBe(true);
    expect(isBlockedFile("report.pdf", "application/x-sh")).toBe(true);
  });

  it("allows documents", () => {
    for (const name of ["a.pdf", "b.docx", "c.xlsx", "d.png", "e.zip", "f.dwg", "noext"]) {
      expect(isBlockedFile(name, "application/octet-stream")).toBe(false);
    }
  });
});

describe("normalizeMimeType / previewKind / extensionOf / formatBytes", () => {
  it("normalises media types", () => {
    expect(normalizeMimeType("Application/PDF; charset=x")).toBe("application/pdf");
    expect(normalizeMimeType("")).toBe("application/octet-stream");
    expect(normalizeMimeType("not a type")).toBe("application/octet-stream");
  });

  it("previews only PDFs and common images", () => {
    expect(previewKind("application/pdf")).toBe("pdf");
    expect(previewKind("image/png")).toBe("image");
    expect(previewKind("image/svg+xml")).toBeNull();
    expect(previewKind("text/html")).toBeNull();
  });

  it("finds extensions", () => {
    expect(extensionOf("a.b.PDF")).toBe("pdf");
    expect(extensionOf(".hidden")).toBe("");
    expect(extensionOf("none")).toBe("");
  });

  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(250 * 1024 * 1024)).toBe("250 MB");
  });
});
