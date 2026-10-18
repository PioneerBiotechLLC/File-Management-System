import { describe, expect, it } from "vitest";
import { DEFAULT_FOLDERS, folderAccess, folderPaths, generalFolderId, type FolderNode } from "./folders";

const folders: FolderNode[] = [
  { id: "sales", parentId: null, name: "Sales", access: "everyone", isActive: true },
  { id: "quotes", parentId: "sales", name: "Quotations", access: "everyone", isActive: true },
  { id: "old", parentId: "sales", name: "Old", access: "everyone", isActive: false },
  { id: "hr", parentId: null, name: "HR", access: "restricted", isActive: true },
  { id: "hr-contracts", parentId: "hr", name: "Contracts", access: "everyone", isActive: true },
  { id: "finance", parentId: null, name: "Finance", access: "everyone", isActive: true },
  { id: "bank", parentId: "finance", name: "Bank", access: "restricted", isActive: true },
];

const sorted = (s: Set<string>) => [...s].sort();

describe("folderAccess", () => {
  it("lets admins see and write everywhere except inactive folders", () => {
    const { visible, writable } = folderAccess(folders, [], "admin");
    expect(visible.size).toBe(folders.length);
    expect(writable.has("old")).toBe(false);
    expect(writable.has("hr-contracts")).toBe(true);
  });

  it("hides a restricted folder and everything under it without a grant", () => {
    const { visible } = folderAccess(folders, [], "editor");
    expect(sorted(visible)).toEqual(["finance", "old", "quotes", "sales"]);
  });

  it("shows a restricted subtree to a user with a grant", () => {
    const { visible, writable } = folderAccess(folders, [{ folderId: "hr", canWrite: false }], "editor");
    expect(visible.has("hr")).toBe(true);
    expect(visible.has("hr-contracts")).toBe(true);
    expect(writable.has("hr-contracts")).toBe(false);
    expect(visible.has("bank")).toBe(false);
  });

  it("allows writing into a restricted subtree only with canWrite", () => {
    const { writable } = folderAccess(folders, [{ folderId: "hr", canWrite: true }], "editor");
    expect(writable.has("hr")).toBe(true);
    expect(writable.has("hr-contracts")).toBe(true);
  });

  it("never lets viewers write, even with a write grant", () => {
    const { visible, writable } = folderAccess(folders, [{ folderId: "bank", canWrite: true }], "viewer");
    expect(visible.has("bank")).toBe(true);
    expect(writable.size).toBe(0);
  });

  it("survives a parent cycle in bad data", () => {
    const cyclic: FolderNode[] = [
      { id: "a", parentId: "b", name: "A", access: "everyone", isActive: true },
      { id: "b", parentId: "a", name: "B", access: "everyone", isActive: true },
    ];
    expect(sorted(folderAccess(cyclic, [], "editor").visible)).toEqual(["a", "b"]);
  });
});

describe("folderPaths", () => {
  it("joins names from the root", () => {
    const paths = folderPaths(folders);
    expect(paths.get("quotes")).toBe("Sales / Quotations");
    expect(paths.get("bank")).toBe("Finance / Bank");
    expect(paths.get("sales")).toBe("Sales");
  });
});

describe("generalFolderId", () => {
  const row = (id: string, name: string, extra: { parentId?: string; nameAr?: string; kind?: string; isActive?: boolean } = {}) => ({
    id,
    name,
    parentId: extra.parentId ?? null,
    nameAr: extra.nameAr ?? null,
    kind: extra.kind ?? "regular",
    isActive: extra.isActive ?? true,
  });

  it("finds the top-level General folder by its English or Arabic name", () => {
    expect(generalFolderId([row("s", "Sales"), row("g", " general ")], new Set(["s", "g"]))).toBe("g");
    expect(generalFolderId([row("g", "Misc", { nameAr: "عام" })], new Set(["g"]))).toBe("g");
  });

  it("ignores a General folder nested elsewhere, closed, or one the user cannot file into", () => {
    expect(generalFolderId([row("s", "Sales"), row("g", "General", { parentId: "s" })], new Set(["s", "g"]))).toBeNull();
    expect(generalFolderId([row("g", "General", { isActive: false })], new Set(["g"]))).toBeNull();
    expect(generalFolderId([row("g", "General")], new Set())).toBeNull();
  });
});

describe("DEFAULT_FOLDERS", () => {
  it("describes every folder, because Claude files by the description", () => {
    const all = DEFAULT_FOLDERS.flatMap((f) => [f, ...(f.children ?? [])]);
    expect(all.length).toBe(16);
    for (const folder of all) {
      expect(folder.description.length).toBeGreaterThan(10);
      expect(folder.nameAr.length).toBeGreaterThan(0);
    }
  });

  it("restricts HR and Bank", () => {
    expect(DEFAULT_FOLDERS.find((f) => f.name === "HR")?.restricted).toBe(true);
    expect(DEFAULT_FOLDERS.find((f) => f.name === "Bank")?.restricted).toBe(true);
  });

  it("holds only the company's own folders; trading documents go under years", () => {
    expect(DEFAULT_FOLDERS.map((f) => f.name)).toEqual(["Quality & Regulatory", "HR", "Legal", "Marketing", "Bank", "General"]);
  });
});
