import { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { UserError } from "@/lib/errors";
import type { FileContext } from "@/lib/files";
import { PROJECT_MAX_LEVELS, cleanFolderName } from "@/lib/project-paths";

/**
 * Turnkey projects: each one is uploaded exactly as it sits on the computer, folders and all, under
 * a top-level Projects folder. The AI never reads these files or files anything into these folders
 * (their kind is "project", and the AI is only offered "regular" folders).
 */

export const PROJECTS_ROOT = {
  name: "Projects",
  nameAr: "المشاريع",
  description: "Turnkey projects, each kept exactly as uploaded with its own folders. The AI does not read or file these.",
} as const;

/** Folders created per request; a large project is sent in several. */
const MAX_PATHS = 500;

type Row = { id: string; parentId: string | null; name: string; kind: string; isActive: boolean };

/** How far below the Projects folder a project folder sits (Projects itself is 0), or null for other folders. */
export function projectLevels(folders: Pick<Row, "id" | "parentId" | "kind">[]): Map<string, number> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const levels = new Map<string, number>();
  const level = (f: Pick<Row, "id" | "parentId" | "kind">, seen = new Set<string>()): number | null => {
    if (f.kind !== "project" || seen.has(f.id)) return null;
    const known = levels.get(f.id);
    if (known !== undefined) return known;
    seen.add(f.id);
    const parent = f.parentId ? byId.get(f.parentId) : undefined;
    const above = parent ? level(parent, seen) : null;
    const value = above === null ? 0 : above + 1;
    levels.set(f.id, value);
    return value;
  };
  for (const f of folders) level(f);
  return levels;
}

/**
 * Lists of folders (the sidebar, Settings, search filters) show project folders down to the
 * projects themselves; a project's own subfolders are reached by opening it.
 */
export function hiddenProjectFolder(levels: Map<string, number>, folderId: string): boolean {
  return (levels.get(folderId) ?? 0) > 1;
}

async function create(prisma: Db, orgId: string, parentId: string | null, name: string, createdBy: string, extra: Partial<Prisma.FolderUncheckedCreateInput> = {}) {
  try {
    return (await prisma.folder.create({ data: { orgId, parentId, name, kind: "project", createdBy, ...extra }, select: { id: true } })).id;
  } catch (error) {
    // Another lane of the same upload made it first.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await prisma.folder.findFirst({ where: { orgId, parentId, name }, select: { id: true, kind: true } });
      if (raced?.kind === "project") return raced.id;
    }
    throw error;
  }
}

/**
 * Makes sure every folder in `paths` ("Project X", "Project X/Drawings", …) exists below `parentId`
 * (or below Projects, created on first use), matching existing folders whatever their case.
 * Returns each path's folder id. Admins only; one audit entry per call that created anything.
 */
export async function ensureProjectFolders(
  prisma: Db,
  ctx: Pick<FileContext, "orgId" | "email" | "role">,
  input: { parentId: string | null; paths: string[] },
): Promise<Record<string, string>> {
  if (ctx.role !== "admin") throw new UserError("Only admins can upload projects.");
  if (input.paths.length > MAX_PATHS) throw new UserError(`Send at most ${MAX_PATHS} folders at a time.`);
  const folders: Row[] = await prisma.folder.findMany({ where: { orgId: ctx.orgId }, select: { id: true, parentId: true, name: true, kind: true, isActive: true } });
  let created = 0;

  // The parent: a project folder, or Projects itself (made on first use).
  let parent: Row | undefined;
  if (input.parentId) {
    parent = folders.find((f) => f.id === input.parentId);
    if (!parent || parent.kind !== "project") throw new UserError("Choose Projects or one of its folders.");
  } else {
    parent = folders.find((f) => f.parentId === null && f.name.toLowerCase() === PROJECTS_ROOT.name.toLowerCase());
    if (parent && parent.kind !== "project") {
      throw new UserError(`A top-level folder called “${parent.name}” already exists and is not a project folder. Rename it in Settings first.`);
    }
    if (!parent) {
      const id = await create(prisma, ctx.orgId, null, PROJECTS_ROOT.name, ctx.email, { nameAr: PROJECTS_ROOT.nameAr, description: PROJECTS_ROOT.description, sortOrder: 100 });
      parent = { id, parentId: null, name: PROJECTS_ROOT.name, kind: "project", isActive: true };
      folders.push(parent);
      created += 1;
    }
  }
  if (!parent.isActive) throw new UserError(`“${parent.name}” is closed. Reopen it in Settings first.`);
  const baseLevel = projectLevels(folders).get(parent.id) ?? 0;

  // Children by parent, matched without regard to case, as Windows and macOS do.
  const children = new Map<string | null, Map<string, Row>>();
  for (const f of folders) {
    const map = children.get(f.parentId) ?? new Map<string, Row>();
    map.set(f.name.toLowerCase(), f);
    children.set(f.parentId, map);
  }

  const ids: Record<string, string> = {};
  for (const path of input.paths) {
    const parts = path.split("/").filter(Boolean).map(cleanFolderName);
    if (parts.length === 0) continue;
    if (baseLevel + parts.length > PROJECT_MAX_LEVELS) throw new UserError(`“${path}” is nested too deep; at most ${PROJECT_MAX_LEVELS} levels below Projects.`);
    let at = parent;
    for (const name of parts) {
      const siblings = children.get(at.id) ?? new Map<string, Row>();
      let next = siblings.get(name.toLowerCase());
      if (next && next.kind !== "project") throw new UserError(`“${next.name}” in “${path}” is not a project folder.`);
      if (next && !next.isActive) throw new UserError(`The folder “${next.name}” in “${path}” is closed. Reopen it in Settings first.`);
      if (!next) {
        next = { id: await create(prisma, ctx.orgId, at.id, name, ctx.email), parentId: at.id, name, kind: "project", isActive: true };
        siblings.set(name.toLowerCase(), next);
        children.set(at.id, siblings);
        created += 1;
      }
      at = next;
    }
    ids[path] = at.id;
  }

  if (created > 0) {
    await prisma.auditLog.create({
      data: { orgId: ctx.orgId, userEmail: ctx.email, action: "folder.import", targetType: "folder", targetId: parent.id, after: { created } },
    });
  }
  return ids;
}
