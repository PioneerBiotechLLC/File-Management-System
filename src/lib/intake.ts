import { z } from "zod";
import { analyzeFile, factsInput, filingIsUsable, storedFacts, type Facts, type Filing } from "@/lib/analysis";
import { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { DOC_TYPES, type DocType } from "@/lib/doc-types";
import { aiEnv, limitsEnv } from "@/lib/env";
import { UserError } from "@/lib/errors";
import { extract } from "@/lib/extract";
import type { FileContext } from "@/lib/files";
import { DOC_KIND_IDS, TECH_KIND_IDS, type DocKindId, type FilingSuggestion, type TechKindId } from "@/lib/file-kinds";
import { suggestFolder, summaryChanged, type ConfirmedSummary } from "@/lib/filing";
import { filingYear, listMaterials, listParties, suggestionFor, type MaterialRow, type PartyRow, type StoredTechnical, type StoredTrading } from "@/lib/parties";
import { can } from "@/lib/permissions";
import { reindexFile } from "@/lib/search-index";
import { getObject, head, objectKey } from "@/lib/storage";

/**
 * What happens to a new upload after its bytes arrive:
 * 1. the AI reads it and drafts a summary (or says why it could not);
 * 2. the uploader checks the draft, or writes the summary, and confirms it;
 * 3. the AI suggests a folder from the confirmed summary; the uploader confirms it (files.moveFile).
 * A file waits in Review until steps 2 and 3 are done, however long that takes.
 */

/** A read that has run longer than this is taken as dead; the uploader may try again. */
export const READ_TIMEOUT_MS = 2 * 60 * 1000;
/** Failed reads may be tried this many times in all; after that the uploader writes the summary. */
export const MAX_READ_ATTEMPTS = 3;

type Company = { name: string; domain: string; timezone: string };

export type ReadOutcome =
  | { status: "read" }
  /** `retryable` when the cause was a failure or a cap, not the file itself. */
  | { status: "not_read"; reason: string; retryable: boolean }
  /** Another request is reading it, or another of the person's AI calls is running; ask again shortly. */
  | { status: "busy" };

const notWaiting = () => new UserError("That file is not waiting to be filed.");

/** The unfiled files this user may work on in Review: their own, or everyone's for admins. */
function waitingWhere(ctx: FileContext, fileId: string): Prisma.StoredFileWhereInput {
  return {
    id: fileId,
    orgId: ctx.orgId,
    deletedAt: null,
    folderId: null,
    status: { in: ["processing", "needs_review"] },
    ...(ctx.role === "admin" ? {} : { uploadedBy: ctx.userId }),
  };
}

function aiConfigured(): boolean {
  const { ANTHROPIC_API_KEY } = process.env;
  return Boolean(ANTHROPIC_API_KEY?.trim());
}

/** The company's own folders the user may file into, as the model sees them. Year folders are not chosen, they are built. */
export function folderChoices(ctx: FileContext) {
  return ctx.folders
    .filter((f) => f.kind === "regular" && f.isActive && ctx.writable.has(f.id))
    .map((f) => ({ id: f.id, path: ctx.paths.get(f.id) ?? f.name, description: f.description }));
}

export const partyChoices = (parties: PartyRow[]) => parties.map((p) => ({ id: p.id, side: p.side, name: p.name, aliases: p.aliases }));
export const materialChoices = (materials: MaterialRow[]) => materials.map((m) => ({ id: m.id, partyId: m.partyId, name: m.name, aliases: m.aliases }));

/** How a filing answer is kept on the file until the uploader confirms it (one column for both trees). */
export function storedFiling(filing: Filing | null) {
  if (!filing) return { suggestedFolderId: null, suggestedTrading: Prisma.DbNull, filingConfidence: null, filingReason: null };
  const trading: StoredTrading | StoredTechnical | null =
    filing.placement === "technical" && (TECH_KIND_IDS as readonly string[]).includes(filing.docKind ?? "")
      ? { tree: "technical", partyId: filing.partyId, partyName: filing.partyName, materialId: filing.materialId, materialName: filing.materialName, docKind: filing.docKind as TechKindId }
      : filing.placement === "trading" && filing.side && (DOC_KIND_IDS as readonly string[]).includes(filing.docKind ?? "")
        ? { side: filing.side, partyId: filing.partyId, partyName: filing.partyName, docKind: filing.docKind as DocKindId }
        : null;
  return {
    suggestedFolderId: filing.placement === "folder" ? filing.folderId : null,
    suggestedTrading: trading ?? Prisma.DbNull,
    filingConfidence: filing.confidence,
    filingReason: filing.reason,
  };
}

/**
 * Reads one freshly uploaded file with the AI and stores the draft on the file. Safe to call
 * again: a finished file reports its state, and a read in progress reports `busy`.
 */
export async function readUpload(prisma: Db, ctx: FileContext, company: Company, fileId: string): Promise<ReadOutcome> {
  if (!can(ctx.role, "review.accept")) throw notWaiting();
  const file = await prisma.storedFile.findFirst({
    where: waitingWhere(ctx, fileId),
    select: { id: true, name: true, originalName: true, mimeType: true, sizeBytes: true, currentVersion: true, status: true, readStatus: true, aiError: true, createdAt: true },
  });
  if (!file) throw notWaiting();
  if (file.status !== "processing") {
    return file.aiError ? { status: "not_read", reason: file.aiError, retryable: file.readStatus === null } : { status: "read" };
  }

  // Take the file; a read older than the timeout is assumed dead.
  const startedAt = new Date();
  const locked = await prisma.storedFile.updateMany({
    where: { id: file.id, status: "processing", OR: [{ processingStartedAt: null }, { processingStartedAt: { lt: new Date(startedAt.getTime() - READ_TIMEOUT_MS) } }] },
    data: { processingStartedAt: startedAt, attempts: { increment: 1 }, aiError: null },
  });
  if (locked.count === 0) return { status: "busy" };

  const finish = async (data: Prisma.StoredFileUncheckedUpdateInput, log: Record<string, unknown>) => {
    await prisma.$transaction([
      prisma.storedFile.update({ where: { id: file.id }, data: { ...data, status: "needs_review", processingStartedAt: null } }),
      prisma.auditLog.create({
        data: { orgId: ctx.orgId, userEmail: ctx.email, action: "file.analyze", targetType: "file", targetId: file.id, after: { name: file.name, ...log } },
      }),
    ]);
  };
  const notRead = async (reason: string, retryable: boolean): Promise<ReadOutcome> => {
    // Also in the server logs, so a run of failures can be diagnosed without the database.
    console.error(`AI read ${retryable ? "failed" : "not possible"} for file ${file.id} (${file.name}): ${reason}`);
    await finish({ readStatus: retryable ? null : "not_read", aiError: reason }, { outcome: retryable ? "failed" : "not_read", reason });
    return { status: "not_read", reason, retryable };
  };

  if (!aiConfigured()) return notRead("AI reading is not set up on this server.", false);
  const maxMb = limitsEnv().FILES_AI_MAX_MB;
  if (file.sizeBytes > maxMb * 1024 * 1024) return notRead(`The file is larger than ${maxMb} MB, the most the AI reads.`, false);

  // The stored object must still be the one that was checked at upload before it is loaded whole.
  const key = objectKey(ctx.orgId, file.id, file.currentVersion);
  const stored = await head(key);
  if (!stored) return notRead("The file was not found in storage.", true);
  if (stored.sizeBytes !== file.sizeBytes) return notRead("The stored file is not the one that was uploaded, so it was not read.", false);
  const bytes = await getObject(key);
  if (!bytes) return notRead("The file was not found in storage.", true);

  let outcome;
  try {
    const extraction = await extract(bytes, file.originalName, file.mimeType);
    outcome = await analyzeFile(
      prisma,
      { orgId: ctx.orgId, timezone: company.timezone, userId: ctx.userId, fileId: file.id },
      {
        model: aiEnv().ANTHROPIC_MODEL,
        company,
        folders: folderChoices(ctx),
        parties: partyChoices(await listParties(prisma, ctx.orgId)),
        materials: materialChoices(await listMaterials(prisma, ctx.orgId)),
        fileName: file.originalName,
        uploadedAt: file.createdAt,
        extraction,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return notRead(`AI reading failed: ${message.slice(0, 200)}`, true);
  }

  if (outcome.status === "limit_reached" && outcome.limit === "user_busy") {
    // Another of this person's AI calls is running (a parallel upload, say). Not an attempt: the
    // file stays in line and the browser asks again shortly.
    await prisma.storedFile.update({ where: { id: file.id }, data: { processingStartedAt: null, attempts: { decrement: 1 } } });
    return { status: "busy" };
  }
  if (outcome.status === "limit_reached") return notRead(outcome.reason, true);
  if (outcome.status === "not_read") return notRead(outcome.reason, false);
  const { analysis } = outcome;
  if (!analysis.readable) return notRead(analysis.problem ?? "The AI could not read this document clearly.", false);

  const usage = await prisma.aiUsage.findFirst({
    where: { fileId: file.id, purpose: "file_analysis", createdAt: { gte: startedAt } },
    orderBy: { createdAt: "desc" },
    select: { costUsd: true },
  });
  await finish(
    {
      title: analysis.title,
      summary: analysis.summary,
      docType: analysis.docType,
      docDate: analysis.docDate,
      language: analysis.language,
      facts: analysis.facts,
      tags: analysis.tags,
      ...storedFiling(filingIsUsable(analysis.filing) ? analysis.filing : null),
      aiModel: outcome.model,
      readStatus: outcome.readStatus,
      aiError: null,
    },
    { outcome: "read", model: outcome.model, costUsd: usage?.costUsd ?? null },
  );
  return { status: "read" };
}

/** Puts a file whose read failed (not one the AI read, or could not read) back in line, a few times at most. */
export async function retryRead(prisma: Db, ctx: FileContext, fileId: string): Promise<void> {
  if (!can(ctx.role, "review.accept")) throw notWaiting();
  const file = await prisma.storedFile.findFirst({
    where: waitingWhere(ctx, fileId),
    select: { id: true, status: true, readStatus: true, aiError: true, attempts: true, summaryConfirmedAt: true },
  });
  if (!file) throw notWaiting();
  if (file.summaryConfirmedAt) throw new UserError("The summary is already confirmed.");
  if (file.status !== "needs_review" || file.readStatus !== null || !file.aiError) throw new UserError("Only a read that failed can be tried again.");
  if (file.attempts >= MAX_READ_ATTEMPTS) throw new UserError(`The AI has tried ${MAX_READ_ATTEMPTS} times. Please write the summary yourself.`);
  await prisma.storedFile.update({ where: { id: file.id }, data: { status: "processing", processingStartedAt: null, aiError: null, readStatus: null } });
}

// ---------------------------------------------------------------------------------------------
// The summary form
// ---------------------------------------------------------------------------------------------

const clean = (parts: string[]) => parts.map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);

/** Tags and amounts: commas, Arabic commas, semicolons or new lines. */
const splitList = (raw: string) => clean(raw.split(/[,،;\n]/));

/**
 * Names and products: one per line (or semicolons). Commas stay inside an item, so
 * "Insulin glargine 100 IU/ml, 3 ml pen" survives a round trip through the form.
 */
const splitLines = (raw: string) => clean(raw.split(/[;\n]/));

const dateField = z
  .string()
  .trim()
  .transform((v, c) => {
    if (v === "") return null;
    const date = new Date(`${v}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== v) {
      c.addIssue({ code: "custom", message: "Enter dates as YYYY-MM-DD." });
      return z.NEVER;
    }
    return date;
  });

/** "1,250.50 AED" or "AED 1250.5", one per line or comma. */
const AMOUNT = /^(?:([A-Za-z]{3})\s*)?(\d+(?:\.\d+)?)(?:\s*([A-Za-z]{3}))?$/;

const amountsField = z.string().transform((raw, c) => {
  const out: { value: number; currency: string }[] = [];
  // Thousands separators ("1,250.50") are not list separators.
  for (const part of splitList(raw.replace(/(?<=\d),(?=\d{3}(?!\d))/g, ""))) {
    const m = part.match(AMOUNT);
    const currency = m?.[1] ?? m?.[3];
    const value = m ? Number(m[2]) : NaN;
    if (!m || !currency || !Number.isFinite(value)) {
      c.addIssue({ code: "custom", message: `Enter amounts as 1250.50 AED, separated by commas (could not read “${part}”).` });
      return z.NEVER;
    }
    out.push({ value, currency: currency.toUpperCase() });
  }
  return out;
});

/** "quotation QT-2291" or just "QT-2291", one per line. */
const referencesField = z.string().transform((raw) =>
  splitLines(raw).map((part) => {
    const space = part.indexOf(" ");
    return space > 0 && space < part.length - 1
      ? { kind: part.slice(0, space).toLowerCase().replaceAll(" ", "_"), value: part.slice(space + 1).trim() }
      : { kind: "reference", value: part };
  }),
);

const tagsField = z.string().transform((raw) => {
  const tags: string[] = [];
  for (const part of splitList(raw)) {
    const tag = part.toLowerCase().slice(0, 40);
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags.slice(0, 20);
});

/** Plenty for a form field; the facts are then cut to the same sizes the AI's are (factsInput). */
const listField = z.string().max(20_000, "That list is too long.");

const summaryForm = z.object({
  title: z.string().trim().max(200).transform((v) => v || null),
  summary: z.string().trim().min(1, "Write a short summary of the document.").max(2_000),
  docType: z.union([z.enum(DOC_TYPES), z.literal("")]).transform((v) => v || null),
  docDate: dateField,
  parties: listField.transform(splitLines),
  references: listField.pipe(referencesField),
  amounts: listField.pipe(amountsField),
  products: listField.transform(splitLines),
  expiryDate: dateField,
  tags: listField.pipe(tagsField),
});

export type SummaryFormInput = z.input<typeof summaryForm>;

/** The stored summary as form text, so the uploader edits exactly what will be saved. */
export function summaryToForm(file: {
  title: string | null;
  summary: string | null;
  docType: string | null;
  docDate: Date | null;
  facts: unknown;
  tags: string[];
}): SummaryFormInput {
  const facts = factsOf(file.facts);
  return {
    title: file.title ?? "",
    summary: file.summary ?? "",
    docType: (DOC_TYPES as readonly string[]).includes(file.docType ?? "") ? (file.docType as DocType) : "",
    docDate: file.docDate?.toISOString().slice(0, 10) ?? "",
    parties: facts.parties.join("\n"),
    references: facts.references.map((r) => (r.kind === "reference" ? r.value : `${r.kind} ${r.value}`)).join("\n"),
    amounts: facts.amounts.map((a) => `${a.value} ${a.currency}`).join(", "),
    products: facts.products.join("\n"),
    expiryDate: facts.expiryDate ?? "",
    tags: file.tags.join(", "),
  };
}

/** Whatever is in the JSON column, as well-formed facts. */
export function factsOf(value: unknown): Facts {
  const parsed = factsInput.safeParse({ parties: [], references: [], amounts: [], products: [], expiryDate: null, ...(value && typeof value === "object" ? value : {}) });
  return parsed.success ? storedFacts(parsed.data) : { parties: [], references: [], amounts: [], products: [] };
}

/**
 * Saves the summary the uploader confirmed and returns the folder the AI suggests for it. The
 * suggestion made while reading is reused when nothing was changed; otherwise the cheaper model
 * chooses again from the confirmed text. No suggestion is not an error: the uploader picks.
 */
export async function confirmSummary(
  prisma: Db,
  ctx: FileContext,
  company: Company,
  input: { fileId: string } & SummaryFormInput,
): Promise<{ suggestion: FilingSuggestion | null }> {
  if (!can(ctx.role, "review.accept")) throw notWaiting();
  const file = await prisma.storedFile.findFirst({
    where: waitingWhere(ctx, input.fileId),
    select: {
      id: true,
      name: true,
      title: true,
      summary: true,
      docType: true,
      docDate: true,
      facts: true,
      tags: true,
      readStatus: true,
      aiModel: true,
      suggestedFolderId: true,
      suggestedTrading: true,
      filingConfidence: true,
      filingReason: true,
      createdAt: true,
    },
  });
  if (!file) throw notWaiting();
  const parsed = summaryForm.safeParse(input);
  if (!parsed.success) throw new UserError(parsed.error.issues[0]?.message ?? "Check the summary and try again.");
  const { tags, parties, references, amounts, products, expiryDate, ...rest } = parsed.data;
  // The same limits as the AI's output: so many parties, products and references, so long each.
  const boundedFacts = factsInput.safeParse({ parties, references, amounts, products, expiryDate: expiryDate?.toISOString().slice(0, 10) ?? null });
  if (!boundedFacts.success) throw new UserError("Check the parties, references, amounts and products, then try again.");
  const facts = storedFacts(boundedFacts.data);
  const confirmed: ConfirmedSummary = { ...rest, docType: rest.docType as DocType | null, facts };

  const aiRead = file.readStatus === "full" || file.readStatus === "partial";
  const draft: ConfirmedSummary = {
    title: file.title,
    summary: file.summary,
    docType: (file.docType as DocType | null) ?? null,
    docDate: file.docDate,
    facts: factsOf(file.facts),
  };
  const edited = !aiRead || summaryChanged(draft, confirmed);
  const now = new Date();
  await prisma.$transaction([
    prisma.storedFile.update({
      where: { id: file.id },
      data: { ...confirmed, facts, tags, status: "needs_review", processingStartedAt: null, summaryConfirmedAt: now, summaryConfirmedBy: ctx.email },
    }),
    prisma.auditLog.create({
      data: {
        orgId: ctx.orgId,
        userEmail: ctx.email,
        action: "file.summary",
        targetType: "file",
        targetId: file.id,
        after: { name: file.name, source: aiRead ? "ai" : "manual", edited: aiRead && edited, title: confirmed.title, summary: confirmed.summary },
      },
    }),
  ]);

  await reindexFile(prisma, file.id);

  const [known, materials] = await Promise.all([listParties(prisma, ctx.orgId), listMaterials(prisma, ctx.orgId)]);
  const year = filingYear(confirmed.docDate, file.createdAt, company.timezone);
  // An unchanged summary keeps the suggestion made while reading, if it still points somewhere usable.
  const kept = edited
    ? null
    : suggestionFor({ folderId: file.suggestedFolderId, trading: file.suggestedTrading, confidence: file.filingConfidence, reason: file.filingReason }, ctx, known, year, materials);
  if (kept || !aiConfigured()) return { suggestion: kept };

  const chosen = await suggestFolder(
    prisma,
    { orgId: ctx.orgId, timezone: company.timezone, userId: ctx.userId, fileId: file.id },
    { model: aiEnv().ANTHROPIC_MODEL_LIGHT, company, folders: folderChoices(ctx), parties: partyChoices(known), materials: materialChoices(materials), summary: confirmed },
  );
  const stored = storedFiling(chosen);
  await prisma.storedFile.update({ where: { id: file.id }, data: stored });
  return {
    suggestion: suggestionFor(
      { folderId: stored.suggestedFolderId, trading: stored.suggestedTrading === Prisma.DbNull ? null : stored.suggestedTrading, confidence: stored.filingConfidence, reason: stored.filingReason },
      ctx,
      known,
      year,
      materials,
    ),
  };
}
