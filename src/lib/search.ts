import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { DOC_TYPES } from "@/lib/doc-types";
import type { FileContext } from "@/lib/files";
import { factsOf } from "@/lib/intake";
import { can } from "@/lib/permissions";
import { UserError } from "@/lib/errors";
import { queryPlans } from "@/lib/search-text";

/**
 * Instant search over the confirmed summaries. Access is enforced here, in SQL: a file outside the
 * folders the user may see never leaves the database, whatever asks (the search page or the AI).
 */

export const SEARCH_LIMIT = 20;

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .transform((v) => new Date(`${v}T00:00:00.000Z`))
  .nullish();

export const searchFilters = z.object({
  /** This folder and everything under it. */
  folderId: z.string().min(1).nullish(),
  docType: z.enum(DOC_TYPES).nullish(),
  dateFrom: date,
  dateTo: date,
  amountMin: z.number().nonnegative().nullish(),
  amountMax: z.number().nonnegative().nullish(),
  /** ISO 4217, e.g. AED. */
  currency: z.string().trim().toUpperCase().length(3).nullish(),
  uploaderId: z.string().min(1).nullish(),
});

export type SearchFilters = z.input<typeof searchFilters>;

export type SearchHit = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  folderId: string | null;
  folderPath: string | null;
  title: string | null;
  summary: string | null;
  /** The matching part of the title and summary, matches marked with « ». */
  snippet: string;
  docType: string | null;
  docDate: Date | null;
  createdAt: Date;
  uploader: string;
  facts: ReturnType<typeof factsOf>;
};

type Row = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  folderId: string | null;
  title: string | null;
  summary: string | null;
  snippet: string | null;
  docType: string | null;
  docDate: Date | null;
  createdAt: Date;
  facts: unknown;
  uploaderName: string | null;
  uploaderEmail: string;
};

/** The folder and its descendants, limited to what the user may see. */
function subtree(ctx: FileContext, folderId: string): string[] {
  const out: string[] = [];
  const walk = (id: string) => {
    if (!ctx.visible.has(id)) return;
    out.push(id);
    for (const f of ctx.folders) if (f.parentId === id) walk(f.id);
  };
  walk(folderId);
  return out;
}

function accessSql(ctx: FileContext, filters: z.output<typeof searchFilters>): Prisma.Sql {
  const folders = filters.folderId ? subtree(ctx, filters.folderId) : [...ctx.visible];
  const inFolders = folders.length > 0 ? Prisma.sql`f."folderId" IN (${Prisma.join(folders)})` : Prisma.sql`FALSE`;
  // Unfiled files belong to their uploader (and admins) until they are filed; a folder filter excludes them.
  const unfiled = filters.folderId ? Prisma.sql`FALSE` : ctx.role === "admin" ? Prisma.sql`f."folderId" IS NULL` : Prisma.sql`(f."folderId" IS NULL AND f."uploadedBy" = ${ctx.userId})`;
  const parts = [
    Prisma.sql`f."orgId" = ${ctx.orgId}`,
    Prisma.sql`f."deletedAt" IS NULL`,
    Prisma.sql`f."status" <> 'uploading'::"FileStatus"`,
    Prisma.sql`(${inFolders} OR ${unfiled})`,
  ];
  if (filters.docType) parts.push(Prisma.sql`f."docType" = ${filters.docType}`);
  if (filters.dateFrom) parts.push(Prisma.sql`f."docDate" >= ${filters.dateFrom}`);
  if (filters.dateTo) parts.push(Prisma.sql`f."docDate" <= ${filters.dateTo}`);
  if (filters.uploaderId) parts.push(Prisma.sql`f."uploadedBy" = ${filters.uploaderId}`);
  if (filters.amountMin != null || filters.amountMax != null || filters.currency) {
    const min = filters.amountMin ?? 0;
    const max = filters.amountMax ?? 1e15;
    const currency = filters.currency ? Prisma.sql`AND upper(a->>'currency') = ${filters.currency}` : Prisma.empty;
    parts.push(
      Prisma.sql`EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(f."facts"->'amounts') = 'array' THEN f."facts"->'amounts' ELSE '[]'::jsonb END) a WHERE (a->>'value')::numeric BETWEEN ${min} AND ${max} ${currency})`,
    );
  }
  return Prisma.join(parts, " AND ");
}

const COLUMNS = Prisma.sql`f."id", f."name", f."mimeType", f."sizeBytes", f."folderId", f."title", f."summary", f."docType", f."docDate", f."createdAt", f."facts", u."name" AS "uploaderName", u."email" AS "uploaderEmail"`;

function toHit(ctx: FileContext, row: Row): SearchHit {
  return {
    id: row.id,
    name: row.name,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    folderId: row.folderId,
    folderPath: row.folderId ? (ctx.paths.get(row.folderId) ?? null) : null,
    title: row.title,
    summary: row.summary,
    snippet: row.snippet?.trim() || [row.title, row.summary].filter(Boolean).join(". ").slice(0, 300),
    docType: row.docType,
    docDate: row.docDate,
    createdAt: row.createdAt,
    uploader: row.uploaderName ?? row.uploaderEmail,
    facts: factsOf(row.facts),
  };
}

export type SearchResult = { hits: SearchHit[]; plan: number | null };

/**
 * Runs the query plans strictest first and returns the first that finds anything, ranked by match
 * quality with a boost for recent files. Without a query, the newest files matching the filters.
 */
export async function searchFiles(prisma: Db, ctx: FileContext, input: { q: string; filters?: SearchFilters; limit?: number }): Promise<SearchResult> {
  if (!can(ctx.role, "file.search")) throw new UserError("You do not have permission to search.");
  const parsed = searchFilters.safeParse(input.filters ?? {});
  if (!parsed.success) throw new UserError("Check the search filters.");
  const filters = parsed.data;
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? SEARCH_LIMIT)), 50);
  const access = accessSql(ctx, filters);
  const q = input.q.trim().slice(0, 300);
  const plans = queryPlans(q);

  if (plans.length === 0) {
    const rows = await prisma.$queryRaw<Row[]>`
      SELECT ${COLUMNS}, NULL AS "snippet" FROM "StoredFile" f JOIN "AppUser" u ON u."id" = f."uploadedBy"
      WHERE ${access} ORDER BY f."createdAt" DESC LIMIT ${limit}`;
    return { hits: rows.map((r) => toHit(ctx, r)), plan: null };
  }

  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  for (const [index, plan] of plans.entries()) {
    const rows = await prisma.$queryRaw<Row[]>`
      SELECT ${COLUMNS},
        ts_headline('simple', coalesce(f."title", '') || '. ' || coalesce(f."summary", ''), to_tsquery('simple', ${plan}),
          'MaxWords=45, MinWords=20, StartSel=«, StopSel=», MaxFragments=1') AS "snippet"
      FROM "StoredFile" f JOIN "AppUser" u ON u."id" = f."uploadedBy"
      WHERE ${access} AND (f."searchVector" @@ to_tsquery('simple', ${plan}) OR f."name" ILIKE ${like})
      ORDER BY ts_rank(coalesce(f."searchVector", ''::tsvector), to_tsquery('simple', ${plan}))
        + CASE WHEN f."name" ILIKE ${like} THEN 0.5 ELSE 0 END
        + 0.1 * exp(-extract(epoch FROM now() - f."createdAt") / (86400 * 365)) DESC,
        f."createdAt" DESC
      LIMIT ${limit}`;
    if (rows.length > 0) return { hits: rows.map((r) => toHit(ctx, r)), plan: index + 1 };
  }
  return { hits: [], plan: plans.length };
}

/** The summary and facts of a few files the user may see, for the AI to read closely. */
export async function getFilesForAsk(prisma: Db, ctx: FileContext, ids: string[]): Promise<SearchHit[]> {
  const wanted = [...new Set(ids)].slice(0, 5);
  if (wanted.length === 0) return [];
  const access = accessSql(ctx, {});
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT ${COLUMNS}, NULL AS "snippet" FROM "StoredFile" f JOIN "AppUser" u ON u."id" = f."uploadedBy"
    WHERE ${access} AND f."id" IN (${Prisma.join(wanted)})`;
  return rows.map((r) => toHit(ctx, r));
}

// ---------------------------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------------------------

const MERGE_WINDOW_MS = 30_000;

/**
 * Records a search. Typing produces a stream of growing queries, so a search that extends (or
 * shortens) the user's previous one within half a minute updates that entry instead of adding one.
 */
export async function logSearch(prisma: Db, ctx: FileContext, input: { q: string; hits: number; filters?: SearchFilters }): Promise<void> {
  const q = input.q.trim().slice(0, 300);
  if (!q) return;
  const after = { query: q, hits: input.hits, ...(input.filters && Object.values(input.filters).some((v) => v != null && v !== "") ? { filters: input.filters } : {}) };
  const previous = await prisma.auditLog.findFirst({
    where: { orgId: ctx.orgId, userEmail: ctx.email, action: "search.instant", createdAt: { gte: new Date(Date.now() - MERGE_WINDOW_MS) } },
    orderBy: { createdAt: "desc" },
    select: { id: true, after: true },
  });
  const last = previous && typeof previous.after === "object" && previous.after && "query" in previous.after ? String(previous.after.query) : null;
  if (previous && last !== null && (q.startsWith(last) || last.startsWith(q))) {
    await prisma.auditLog.update({ where: { id: previous.id }, data: { after } });
    return;
  }
  await prisma.auditLog.create({ data: { orgId: ctx.orgId, userEmail: ctx.email, action: "search.instant", targetType: "search", targetId: ctx.userId, after } });
}
