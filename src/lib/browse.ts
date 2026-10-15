import { z } from "zod";
import type { Db } from "@/lib/db";
import { DOC_KINDS, DOC_KIND_IDS, SIDES, SIDE_FOLDERS, TECH_KINDS, TECH_KIND_IDS, type DocKindId, type PartySide, type TechKindId } from "@/lib/file-kinds";
import type { FileContext } from "@/lib/files";
import { listMaterials, listParties } from "@/lib/parties";

/**
 * Browsing filed documents without the AI. Commercial: year, side, company and kind, which are
 * the doc folder's own fields. Technical: manufacturer, material and kind, the tech_doc folder's
 * fields. Counts are files per folder, and each dropdown offers only the values that still have
 * a file given the other filters.
 */

export const TREES = ["trading", "technical"] as const;
export type BrowseTree = (typeof TREES)[number];

/** Each field on its own: a bad value in the address drops that filter, not the others. */
export const browseFilter = z.object({
  tree: z.enum(TREES).catch("trading").default("trading"),
  year: z.coerce.number().int().min(1990).max(2100).nullish().catch(null),
  side: z.enum(SIDES).nullish().catch(null),
  partyId: z.string().max(64).nullish().catch(null),
  materialId: z.string().max(64).nullish().catch(null),
  docKind: z.string().max(40).nullish().catch(null),
});
/** As it comes from the address bar. */
export type BrowseFilter = { tree?: string | null; year?: string | number | null; side?: string | null; partyId?: string | null; materialId?: string | null; docKind?: string | null };

export type Facet<V extends string | number> = { value: V; label: string; count: number };
export type BrowseResult = {
  tree: BrowseTree;
  filter: z.output<typeof browseFilter>;
  active: boolean;
  /** Whether each tree holds any file at all, so the switch is only offered when it is worth it. */
  trees: Record<BrowseTree, boolean>;
  // Commercial
  years: Facet<number>[];
  sides: Facet<PartySide>[];
  parties: (Facet<string> & { side: PartySide })[];
  docKinds: Facet<DocKindId>[];
  // Technical
  makers: Facet<string>[];
  materials: (Facet<string> & { partyId: string })[];
  techKinds: Facet<TechKindId>[];
  /** Folders matching every filter; empty with no filter set or when nothing matches. */
  folderIds: string[];
  total: number;
};

type Leaf = { id: string; year: number | null; side: PartySide | null; partyId: string; materialId: string | null; docKind: string; count: number };

const sum = (folders: Leaf[]) => folders.reduce((n, f) => n + f.count, 0);

export async function browseTrading(prisma: Db, ctx: FileContext, raw: BrowseFilter = {}): Promise<BrowseResult> {
  const filter = browseFilter.parse(raw);
  const tree = filter.tree;
  if (filter.docKind && !((tree === "trading" ? DOC_KIND_IDS : TECH_KIND_IDS) as readonly string[]).includes(filter.docKind)) filter.docKind = null;
  if (tree === "technical") {
    filter.year = null;
    filter.side = null;
  } else filter.materialId = null;
  const active = Boolean(filter.year || filter.side || filter.partyId || filter.materialId || filter.docKind);

  // Visible leaf folders of both trees, with how many files each holds (a file is in exactly one folder).
  const candidates = ctx.folders.filter((f) => (f.kind === "doc" || f.kind === "tech_doc") && f.isActive && ctx.visible.has(f.id) && f.partyId && f.docKind);
  const counts = candidates.length
    ? await prisma.storedFile.groupBy({
        by: ["folderId"],
        where: { orgId: ctx.orgId, folderId: { in: candidates.map((f) => f.id) }, status: "ready", deletedAt: null },
        _count: { _all: true },
      })
    : [];
  const countOf = new Map(counts.map((c) => [c.folderId, c._count._all]));
  const leaves: Leaf[] = candidates
    .map((f) => ({ id: f.id, year: f.year, side: f.side, partyId: f.partyId!, materialId: f.materialId, docKind: f.docKind!, count: countOf.get(f.id) ?? 0 }))
    .filter((f) => f.count > 0);
  const trees: Record<BrowseTree, boolean> = {
    trading: leaves.some((f) => f.materialId === null && f.year !== null),
    technical: leaves.some((f) => f.materialId !== null),
  };
  const mine = leaves.filter((f) => (tree === "technical" ? f.materialId !== null : f.materialId === null && f.year !== null));

  type Key = "year" | "side" | "partyId" | "materialId" | "docKind";
  const matches = (f: Leaf, except?: Key) =>
    (except === "year" || !filter.year || f.year === filter.year) &&
    (except === "side" || !filter.side || f.side === filter.side) &&
    (except === "partyId" || !filter.partyId || f.partyId === filter.partyId) &&
    (except === "materialId" || !filter.materialId || f.materialId === filter.materialId) &&
    (except === "docKind" || !filter.docKind || f.docKind === filter.docKind);

  const group = <V extends string | number>(except: Key, key: (f: Leaf) => V | null): Map<V, number> => {
    const out = new Map<V, number>();
    for (const f of mine) {
      const k = key(f);
      if (k !== null && matches(f, except)) out.set(k, (out.get(k) ?? 0) + f.count);
    }
    return out;
  };

  const empty: BrowseResult = { tree, filter, active, trees, years: [], sides: [], parties: [], docKinds: [], makers: [], materials: [], techKinds: [], folderIds: [], total: 0 };
  const byParty = group("partyId", (f) => f.partyId);
  const parties = byParty.size ? (await listParties(prisma, ctx.orgId)).filter((p) => byParty.has(p.id)) : [];
  const byKind = group("docKind", (f) => f.docKind);
  const matched = active ? mine.filter((f) => matches(f)) : [];
  const result = { ...empty, folderIds: matched.map((f) => f.id), total: sum(matched) };

  if (tree === "technical") {
    const byMaterial = group("materialId", (f) => f.materialId);
    const materials = byMaterial.size ? (await listMaterials(prisma, ctx.orgId)).filter((m) => byMaterial.has(m.id)) : [];
    return {
      ...result,
      makers: parties.map((p) => ({ value: p.id, label: p.name, count: byParty.get(p.id)! })),
      materials: materials.map((m) => ({ value: m.id, label: m.name, partyId: m.partyId, count: byMaterial.get(m.id)! })),
      techKinds: TECH_KINDS.flatMap((k) => {
        const count = byKind.get(k.id);
        return count ? [{ value: k.id, label: k.name, count }] : [];
      }),
    };
  }
  return {
    ...result,
    years: [...group("year", (f) => f.year)].sort((a, b) => b[0] - a[0]).map(([value, count]) => ({ value, label: String(value), count })),
    sides: SIDES.flatMap((value) => {
      const count = group("side", (f) => f.side).get(value);
      return count ? [{ value, label: SIDE_FOLDERS[value].name, count }] : [];
    }),
    parties: parties.map((p) => ({ value: p.id, label: p.name, side: p.side, count: byParty.get(p.id)! })),
    docKinds: DOC_KINDS.flatMap((k) => {
      const count = byKind.get(k.id);
      return count ? [{ value: k.id, label: k.name, count }] : [];
    }),
  };
}
