import { BlobReader, BlobWriter, TextReader, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";
import { isZipName, zipEntries } from "./zip-entries";

async function zipOf(files: Record<string, string | Blob>, password?: string): Promise<Blob> {
  const writer = new ZipWriter(new BlobWriter("application/zip"), { useWebWorkers: false, password });
  for (const [name, content] of Object.entries(files)) {
    if (name.endsWith("/")) await writer.add(name, undefined, { directory: true });
    else await writer.add(name, typeof content === "string" ? new TextReader(content) : new BlobReader(content));
  }
  return writer.close();
}

describe("zipEntries", () => {
  it("lists each document with its path inside the zip, and unpacks it on demand", async () => {
    const zip = await zipOf({ "2025/": "", "2025/PO-4512.pdf": "%PDF-1.7 order", "notes.txt": "hello", "__MACOSX/2025/._PO-4512.pdf": "junk" });
    const entries = (await zipEntries(zip, "Orders.zip"))!;
    expect(entries.map((e) => [e.relPath, e.name, e.size])).toEqual([
      ["Orders.zip/2025/PO-4512.pdf", "PO-4512.pdf", 14],
      ["Orders.zip/notes.txt", "notes.txt", 5],
    ]);
    const file = await entries[0]!.load();
    expect(file.name).toBe("PO-4512.pdf");
    expect(file.type).toBe("application/pdf");
    expect(await file.text()).toBe("%PDF-1.7 order");
  });

  it("opens zips inside zips", async () => {
    const inner = await zipOf({ "coa.pdf": "%PDF coa" });
    const entries = (await zipEntries(await zipOf({ "batch.zip": inner, "a.txt": "a" }), "Outer.zip"))!;
    expect(entries.map((e) => e.relPath)).toEqual(["Outer.zip/batch.zip/coa.pdf", "Outer.zip/a.txt"]);
    expect(await (await entries[0]!.load()).text()).toBe("%PDF coa");
  });

  it("flags password-protected documents, and returns null for something that is not a zip", async () => {
    const entries = (await zipEntries(await zipOf({ "secret.pdf": "x" }, "pw"), "Locked.zip"))!;
    expect(entries).toMatchObject([{ relPath: "Locked.zip/secret.pdf", problem: "Password-protected inside the zip" }]);
    expect(await zipEntries(new Blob(["not a zip at all"]), "Broken.zip")).toBeNull();
  });

  it("recognises zips by name", () => {
    expect(isZipName("Orders.ZIP")).toBe(true);
    expect(isZipName("report.docx")).toBe(false);
  });
});
