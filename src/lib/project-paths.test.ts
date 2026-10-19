import { describe, expect, it } from "vitest";
import { cleanFolderName, folderOf, foldersNeeded } from "./project-paths";
import { hiddenProjectFolder, projectLevels } from "./projects";

describe("project paths", () => {
  it("keeps names as the computer shows them, minus what a folder name cannot hold", () => {
    expect(cleanFolderName("  Site  A   ")).toBe("Site A");
    expect(cleanFolderName("Rev 2.")).toBe("Rev 2");
    expect(cleanFolderName("a\\b")).toBe("a-b");
    expect(cleanFolderName("مشروع الشارقة")).toBe("مشروع الشارقة");
    expect(cleanFolderName("..")).toBe("Folder");
    expect(cleanFolderName("x".repeat(150))).toHaveLength(100);
  });

  it("finds each file's folder and every folder needed, parents first", () => {
    expect(folderOf("Project X/Drawings/Rev 2/a.dwg")).toBe("Project X/Drawings/Rev 2");
    expect(folderOf("loose.pdf")).toBe("");
    expect(foldersNeeded(["Project X/Drawings/Rev 2/a.dwg", "Project X/BOQ.xlsx", "Project X/Drawings/b.pdf", "Project X/Site/photo.jpg"])).toEqual([
      "Project X",
      "Project X/Drawings",
      "Project X/Site",
      "Project X/Drawings/Rev 2",
    ]);
  });

  it("measures how deep project folders sit, and hides those below the projects themselves", () => {
    const folders = [
      { id: "root", parentId: null, kind: "project" },
      { id: "p1", parentId: "root", kind: "project" },
      { id: "d1", parentId: "p1", kind: "project" },
      { id: "d2", parentId: "d1", kind: "project" },
      { id: "hr", parentId: null, kind: "regular" },
    ];
    const levels = projectLevels(folders);
    expect([...levels.entries()]).toEqual([["root", 0], ["p1", 1], ["d1", 2], ["d2", 3]]);
    expect(["root", "p1", "d1", "d2", "hr"].map((id) => hiddenProjectFolder(levels, id))).toEqual([false, false, true, true, false]);
  });
});
