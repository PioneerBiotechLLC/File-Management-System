import { describe, expect, it } from "vitest";
import { fileKindsFor } from "./file-kinds";
import { DEFAULT_FOLDERS, folderPaths } from "./folders";

/** The default folder tree, with ids equal to their paths. */
function defaultPaths(): Map<string, string> {
  const folders: { id: string; parentId: string | null; name: string }[] = [];
  const walk = (list: typeof DEFAULT_FOLDERS, parent: string | null) => {
    for (const f of list) {
      const id = parent ? `${parent} / ${f.name}` : f.name;
      folders.push({ id, parentId: parent, name: f.name });
      if (f.children) walk(f.children, id);
    }
  };
  walk(DEFAULT_FOLDERS, null);
  return folderPaths(folders);
}

describe("fileKindsFor", () => {
  it("maps every answer to a folder in the default tree", () => {
    const paths = defaultPaths();
    const kinds = fileKindsFor(paths, new Set(paths.keys()));
    expect(kinds).toHaveLength(25);
    expect(kinds.find((k) => k.id === "supplier-invoice")).toMatchObject({ folderId: "Purchasing / Supplier Invoices", docType: "invoice" });
    expect(kinds.find((k) => k.id === "general")).toMatchObject({ folderId: "General", group: "Other" });
  });

  it("hides answers whose folder the person cannot upload to, or that no longer exists", () => {
    const paths = defaultPaths();
    const writable = new Set([...paths.keys()].filter((id) => !id.startsWith("HR") && id !== "Finance / Bank"));
    paths.delete("Logistics / Customs");
    const ids = fileKindsFor(paths, writable).map((k) => k.id);
    expect(ids).not.toContain("employment-contract");
    expect(ids).not.toContain("bank");
    expect(ids).not.toContain("customs");
    expect(ids).toContain("coa");
  });
});
