import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { UserError } from "@/lib/errors";
import {
  DOC_KINDS,
  DOC_KIND_IDS,
  SIDES,
  SIDE_FOLDERS,
  cleanPartyName,
  docKind,
  matchParty,
  partyKey,
  tradingPath,
  type Destination,
  type DocKindId,
  type FilingSuggestion,
  type PartySide,
} from "@/lib/file-kinds";
import { checkCanMove, fileContext, moveFile, type FileContext } from "@/lib/files";

/**
 * Customers and suppliers, and the folders their documents live in:
 * `<year> / Customers|Suppliers / <company> / <kind>`. Folders are created the first time a
 * document needs them, so the tree only ever shows what holds files.
 */

export type PartyRow = { id: string; side: PartySide; name: string; key: string; aliases: string[] };

export async function listParties(prisma: Db, orgId: string): Promise<PartyRow[]> {
  return prisma.party.findMany({ where: { orgId }, select: { id: true, side: true, name: true, key: true, aliases: true }, orderBy: { name: "asc" } });
}

/** The year a document is filed under: its own date, else the day it was uploaded (company time). */
export function filingYear(docDate: Date | null, uploadedAt: Date, timezone: string): number {
  if (docDate) return docDate.getUTCFullYear();
  return Number(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric" }).format(uploadedAt));
}

export const destinationInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("folder"), folderId: z.string().min(1) }),
  z.object({
    kind: z.literal("trading"),
    year: z.number().int().min(1990).max(new Date().getFullYear() + 1),
    side: z.enum(SIDES),
    partyId: z.string().min(1).nullable(),
    partyName: z.string().max(200),
    docKind: z.enum(DOC_KIND_IDS),
  }),
]);

/** The AI's customer/supplier suggestion, as stored on the file. */
export const storedTrading = z.object({
  side: z.enum(SIDES),
  partyId: z.string().nullable(),
  partyName: z.string().nullable(),
  docKind: z.enum(DOC_KIND_IDS),
});
export type StoredTrading = z.infer<typeof storedTrading>;

/**
 * Turns a stored or fresh suggestion into something the uploader can confirm, checked against
 * what exists now: a folder they can still file into, a party that still exists.
 */
export function suggestionFor(
  input: { folderId: string | null; trading: unknown; confidence: number | null; reason: string | null },
  ctx: Pick<FileContext, "writable" | "paths">,
  parties: PartyRow[],
  year: number,
): FilingSuggestion | null {
  const base = { confidence: input.confidence ?? 0, reason: input.reason ?? "" };
  if (input.folderId && ctx.writable.has(input.folderId)) {
    return { ...base, destination: { kind: "folder", folderId: input.folderId }, path: ctx.paths.get(input.folderId) ?? "", newParty: false, seenAs: null };
  }
  const trading = storedTrading.safeParse(input.trading);
  if (!trading.success) return null;
  const { side, partyId, partyName, docKind: kind } = trading.data;
  const printed = partyName ? cleanPartyName(partyName) : "";
  const party = parties.find((p) => p.id === partyId && p.side === side) ?? (printed ? matchParty(parties, side, printed) : null);
  if (!party && !printed) return null;
  const destination: Destination = { kind: "trading", year, side, partyId: party?.id ?? null, partyName: party?.name ?? printed, docKind: kind };
  return {
    ...base,
    destination,
    path: tradingPath(destination),
    newParty: !party,
    seenAs: party && printed && partyKey(printed) !== party.key ? printed : null,
  };
}

/** Finds a folder by parent and name, or creates it; safe when two requests do it at once. */
async function ensureFolder(
  prisma: Db,
  orgId: string,
  createdBy: string,
  where: { parentId: string | null; name: string; partyId?: string },
  data: Omit<Prisma.FolderUncheckedCreateInput, "orgId" | "parentId" | "name" | "createdBy">,
): Promise<string> {
  const find = () =>
    prisma.folder.findFirst({
      where: { orgId, parentId: where.parentId, ...(where.partyId ? { OR: [{ partyId: where.partyId, kind: "party" }, { name: where.name }] } : { name: where.name }) },
      select: { id: true },
    });
  const existing = await find();
  if (existing) return existing.id;
  try {
    return (await prisma.folder.create({ data: { ...data, orgId, parentId: where.parentId, name: where.name, createdBy }, select: { id: true } })).id;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await find();
      if (raced) return raced.id;
    }
    throw error;
  }
}

/** The existing party, or a new one (audited), plus any new spelling learnt for it. */
async function resolveParty(prisma: Db, ctx: FileContext, side: PartySide, partyId: string | null, rawName: string, seenAs: string | null): Promise<PartyRow> {
  const parties = await listParties(prisma, ctx.orgId);
  const name = cleanPartyName(rawName);
  let party = partyId ? (parties.find((p) => p.id === partyId) ?? null) : null;
  if (partyId && !party) throw new UserError("That customer or supplier no longer exists. Choose again.");
  if (party && party.side !== side) party = null;
  party ??= name ? matchParty(parties, side, name) : null;

  if (!party) {
    const key = partyKey(name);
    if (key.length < 2) throw new UserError(`Write the ${SIDE_FOLDERS[side].label.toLowerCase()}'s name.`);
    try {
      party = await prisma.party.create({ data: { orgId: ctx.orgId, side, name, key, createdBy: ctx.email }, select: { id: true, side: true, name: true, key: true, aliases: true } });
      await prisma.auditLog.create({
        data: { orgId: ctx.orgId, userEmail: ctx.email, action: "party.create", targetType: "party", targetId: party.id, after: { name, side } },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
      party = await prisma.party.findUniqueOrThrow({
        where: { orgId_side_key: { orgId: ctx.orgId, side, key } },
        select: { id: true, side: true, name: true, key: true, aliases: true },
      });
    }
  }

  // Remember how this document spelled the company, so the AI matches it next time.
  for (const spelling of [name, seenAs ?? ""]) {
    const key = partyKey(spelling);
    if (key && key !== party.key && !party.aliases.includes(key) && party.aliases.length < 20) {
      party = await prisma.party.update({ where: { id: party.id }, data: { aliases: { push: key } }, select: { id: true, side: true, name: true, key: true, aliases: true } });
    }
  }
  return party;
}

/** The folder a destination means, creating the year, side, company and kind folders as needed. */
async function resolveDestination(prisma: Db, ctx: FileContext, destination: Destination, seenAs: string | null): Promise<string> {
  if (destination.kind === "folder") return destination.folderId;
  const { year, side } = destination;
  const party = await resolveParty(prisma, ctx, side, destination.partyId, destination.partyName, seenAs);
  const kind = docKind(destination.docKind);
  const by = ctx.email;
  // Years sort newest first and above the company's own folders.
  const yearId = await ensureFolder(prisma, ctx.orgId, by, { parentId: null, name: String(year) }, { kind: "year", year, sortOrder: -year, description: `Documents exchanged with customers and suppliers in ${year}.` });
  const sideId = await ensureFolder(prisma, ctx.orgId, by, { parentId: yearId, name: SIDE_FOLDERS[side].name }, { kind: "side", year, side, sortOrder: SIDE_FOLDERS[side].sortOrder });
  const partyFolderId = await ensureFolder(prisma, ctx.orgId, by, { parentId: sideId, name: party.name, partyId: party.id }, { kind: "party", year, side, partyId: party.id });
  return ensureFolder(
    prisma,
    ctx.orgId,
    by,
    { parentId: partyFolderId, name: kind.name },
    { kind: "doc", year, side, partyId: party.id, docKind: kind.id, sortOrder: DOC_KINDS.findIndex((k) => k.id === kind.id) },
  );
}

/**
 * Files (or moves) a file to a destination. Permission is checked before anything is created, so a
 * refused request never leaves new folders or parties behind.
 */
export async function fileTo(prisma: Db, ctx: FileContext, input: { fileId: string; destination: Destination; seenAs?: string | null }): Promise<{ folderId: string }> {
  await checkCanMove(prisma, ctx, input.fileId);
  if (input.destination.kind === "folder") {
    await moveFile(prisma, ctx, { fileId: input.fileId, folderId: input.destination.folderId });
    return { folderId: input.destination.folderId };
  }
  const folderId = await resolveDestination(prisma, ctx, input.destination, input.seenAs ?? null);
  // New folders are not in the context yet, and an admin may have restricted or closed an existing one.
  const fresh = await fileContext(prisma, ctx);
  await moveFile(prisma, fresh, { fileId: input.fileId, folderId });
  return { folderId };
}

/** Where a filed file sits, as a destination the picker can start from. */
export function destinationOf(folderId: string | null, ctx: Pick<FileContext, "folders">, parties: PartyRow[]): Destination | null {
  const folder = folderId ? ctx.folders.find((f) => f.id === folderId) : undefined;
  if (!folder) return null;
  if (folder.kind === "doc" && folder.year && folder.side && folder.partyId && (DOC_KIND_IDS as string[]).includes(folder.docKind ?? "")) {
    const party = parties.find((p) => p.id === folder.partyId);
    if (party) return { kind: "trading", year: folder.year, side: folder.side, partyId: party.id, partyName: party.name, docKind: folder.docKind as DocKindId };
  }
  return { kind: "folder", folderId: folder.id };
}
