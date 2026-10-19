/**
 * Folder paths for uploading a project as it is. Shared by the browser (to work out which folders
 * a picked folder needs) and the server (to create them), so both clean names the same way.
 */

/** Deepest a project folder may sit below Projects. */
export const PROJECT_MAX_LEVELS = 20;

/** A folder name as the app can store it: no slashes or control characters, at most 100 characters. */
export function cleanFolderName(raw: string): string {
  const name = raw
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "")
    .replace(/[\\/]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    // Windows drops trailing dots and spaces; keep names that survive a round trip.
    .replace(/[. ]+$/, "")
    .slice(0, 100)
    .trim();
  return name === "" || name === "." || name === ".." ? "Folder" : name;
}

/** "Project X/Drawings/a.dwg" → "Project X/Drawings": the folder a picked file goes in. */
export function folderOf(relPath: string): string {
  const parts = relPath.split("/").filter(Boolean);
  parts.pop();
  return parts.map(cleanFolderName).join("/");
}

/** Every folder the files need, parents before children: "A", "A/B", "A/B/C". */
export function foldersNeeded(relPaths: string[]): string[] {
  const all = new Set<string>();
  for (const path of relPaths) {
    const parts = folderOf(path).split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) all.add(parts.slice(0, i).join("/"));
  }
  return [...all].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}
