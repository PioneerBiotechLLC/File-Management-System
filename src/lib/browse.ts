import { z } from "zod";
import type { Db } from "@/lib/db";
import { DOC_KINDS, DOC_KIND_IDS, SIDES, SIDE_FOLDERS, type DocKindId, type PartySide } from "@/lib/file-kinds";
import type { FileContext } from "@/lib/files";
import { listParties } from "@/lib/parties";

/**
 * Browsing the customer and supplier documents by year, side, company and kind, without the AI.
 * A document's place in `<year> / Customers|Suppliers / <company> / <kind>` is its doc folder, so
 * the four filters are the doc folder's own fields and the counts are files per doc folder. Each
 * dropdown offers only the values that still have a file given the other three filters.
 */

/** Each field on its own: a bad value in the address drops that filter, not the others. */
export const browseFilter = z.object({
  year: z.coerce.number().int().min(1990).max(2100).nullish().catch(null),
  side: z.enum(SIDES).nullish().catch(null),
  partyId: z.string().max(64).nullish().catch(null),
  docKind: z.enum(DOC_KIND_IDS).nullish().catch(null),
});
/** As it comes from the address bar. */
export type BrowseFilter = { year?: string | number | null; side?: string | null; partyId?: string | null; docKind?: string | null };

export type Facet<V extends string | number> = { value: V; label: string; count: number };
export type BrowseResult = {
  filter: z.output<typeof browseFilter>;
  active: boolean;
  years: Facet<number>[];
  sides: Facet<PartySide>[];
  parties: (Facet<string> & { side: PartySide })[];
  docKinds: Facet<DocKindId>[];
  /** Doc folders matching every filter; empty with no filter set or when nothing matches. */
  folderIds: string[];
  total: number;
};

type DocFolder = { id: string; year: number; side: PartySide; partyId: string; docKind: string; count: number };

const sum = (folders: DocFolder[]) => folders.reduce((n, f) => n + f.count, 0);

export async function browseTrading(prisma: Db, ctx: FileContext, raw: BrowseFilter = {}): Promise<BrowseResult> {
  const filter = browseFilter.parse(raw);
  const active = Boolean(filter.year || filter.side || filter.partyId || filter.docKind);

  // Visible doc folders, with how many files each holds (a file is in exactly one folder).
  const candidates = ctx.folders.filter((f) => f.kind === "doc" && f.isActive && ctx.visible.has(f.id) && f.year && f.side && f.partyId && f.docKind);
  const counts = candidates.length
    ? await prisma.storedFile.groupBy({
        by: ["folderId"],
        where: { orgId: ctx.orgId, folderId: { in: candidates.map((f) => f.id) }, status: "ready", deletedAt: null },
        _count: { _all: true },
      })
    : [];
  const countOf = new Map(counts.map((c) => [c.folderId, c._count._all]));
  const docFolders: DocFolder[] = candidates
    .map((f) => ({ id: f.id, year: f.year!, side: f.side!, partyId: f.partyId!, docKind: f.docKind!, count: countOf.get(f.id) ?? 0 }))
    .filter((f) => f.count > 0);

  const matches = (f: DocFolder, except?: keyof typeof filter) =>
    (except === "year" || !filter.year || f.year === filter.year) &&
    (except === "side" || !filter.side || f.side === filter.side) &&
    (except === "partyId" || !filter.partyId || f.partyId === filter.partyId) &&
    (except === "docKind" || !filter.docKind || f.docKind === filter.docKind);

  const group = <V extends string | number>(except: keyof typeof filter, key: (f: DocFolder) => V): Map<V, number> => {
    const out = new Map<V, number>();
    for (const f of docFolders) if (matches(f, except)) out.set(key(f), (out.get(key(f)) ?? 0) + f.count);
    return out;
  };

  const years = [...group("year", (f) => f.year)].sort((a, b) => b[0] - a[0]).map(([value, count]) => ({ value, label: String(value), count }));
  const sides = SIDES.flatMap((value) => {
    const count = group("side", (f) => f.side).get(value);
    return count ? [{ value, label: SIDE_FOLDERS[value].name, count }] : [];
  });
  const byParty = group("partyId", (f) => f.partyId);
  const parties = byParty.size
    ? (await listParties(prisma, ctx.orgId))
        .filter((p) => byParty.has(p.id))
        .map((p) => ({ value: p.id, label: p.name, side: p.side, count: byParty.get(p.id)! }))
    : [];
  const byKind = group("docKind", (f) => f.docKind);
  const docKinds = DOC_KINDS.flatMap((k) => {
    const count = byKind.get(k.id);
    return count ? [{ value: k.id, label: k.name, count }] : [];
  });

  const matched = active ? docFolders.filter((f) => matches(f)) : [];
  return { filter, active, years, sides, parties, docKinds, folderIds: matched.map((f) => f.id), total: sum(matched) };
}
