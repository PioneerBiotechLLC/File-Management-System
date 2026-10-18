import type { Db } from "@/lib/db";
import { UserError } from "@/lib/errors";
import type { FileContext } from "@/lib/files";
import type { Destination, FilingSuggestion } from "@/lib/file-kinds";
import { generalFolderId } from "@/lib/folders";
import { fileTo, yearChoice, listMaterials, listParties, suggestionFor } from "@/lib/parties";
import { reindexFile } from "@/lib/search-index";

/**
 * Bulk upload: an admin's files are filed straight after the AI reads them, with no one
 * confirming. A file is filed only when the AI read it and was at least AUTO_FILE_THRESHOLD sure;
 * otherwise it waits in Review like any other upload. A file the AI is sure about but that has no
 * place in the tree goes to General, marked unsure.
 */

export const AUTO_FILE_THRESHOLD = 0.5;

export type BulkOutcome =
  | { action: "filed"; path: string; confidence: number; newParty: string | null; unsure: boolean }
  | { action: "review"; reason: string };

/**
 * Where the AI's answer files a file with no one confirming, or why it waits. Below the threshold
 * it waits; sure, but naming no place in the tree, it goes to General when `general` allows.
 */
export function autoFileTarget(
  suggestion: FilingSuggestion | null,
  storedConfidence: number | null,
  ctx: Pick<FileContext, "folders" | "writable" | "paths">,
  opts: { threshold: number; general: boolean },
): FilingSuggestion | { wait: string } {
  const confidence = suggestion?.confidence ?? storedConfidence ?? 0;
  const percent = Math.round(confidence * 100);
  if (confidence < opts.threshold) {
    return { wait: suggestion ? `The AI was only ${percent}% sure it belongs in ${suggestion.path}.` : `The AI could not tell where it belongs (${percent}% sure).` };
  }
  if (suggestion) return suggestion;
  const general = opts.general ? generalFolderId(ctx.folders, ctx.writable) : null;
  if (!general) return { wait: opts.general ? "The AI found no place for it, and there is no General folder to put it in." : "The AI could not tell where it belongs." };
  const destination = { kind: "folder", folderId: general } as const;
  return { destination, path: ctx.paths.get(general) ?? "General", newParty: false, newMaterial: false, seenAs: null, confidence, reason: "No place in the tree" };
}

/** Files a file where the AI chose, marking it unsure when that is General. Returns whether it was. */
export async function fileByAi(prisma: Db, ctx: FileContext, input: { fileId: string; destination: Destination; seenAs?: string | null }): Promise<boolean> {
  const { folderId } = await fileTo(prisma, ctx, input);
  const unsure = folderId === generalFolderId(ctx.folders, ctx.writable);
  if (unsure) await prisma.storedFile.update({ where: { id: input.fileId }, data: { unsure: true } });
  return unsure;
}

export async function autoFileAfterRead(
  prisma: Db,
  ctx: FileContext,
  company: { timezone: string },
  fileId: string,
): Promise<BulkOutcome> {
  if (ctx.role !== "admin") throw new UserError("Only admins can file without confirming.");
  const file = await prisma.storedFile.findFirst({
    where: { id: fileId, orgId: ctx.orgId, folderId: null, deletedAt: null },
    select: {
      id: true,
      name: true,
      status: true,
      readStatus: true,
      aiError: true,
      docDate: true,
      createdAt: true,
      summaryConfirmedAt: true,
      suggestedFolderId: true,
      suggestedTrading: true,
      filingConfidence: true,
      filingReason: true,
    },
  });
  if (!file) throw new UserError("That file was not found, or is already filed.");
  if (file.status !== "needs_review" || file.summaryConfirmedAt) throw new UserError("That file is not waiting to be filed.");
  if (file.readStatus !== "full" && file.readStatus !== "partial") {
    return { action: "review", reason: file.aiError ? `The AI could not read it: ${file.aiError}` : "The AI did not read it." };
  }

  const [parties, materials] = await Promise.all([listParties(prisma, ctx.orgId), listMaterials(prisma, ctx.orgId)]);
  const year = yearChoice(file.docDate, file.createdAt, company.timezone);
  const suggestion = suggestionFor(
    { folderId: file.suggestedFolderId, trading: file.suggestedTrading, confidence: file.filingConfidence, reason: file.filingReason },
    ctx,
    parties,
    year,
    materials,
  );
  const target = autoFileTarget(suggestion, file.filingConfidence, ctx, { threshold: AUTO_FILE_THRESHOLD, general: true });
  if ("wait" in target) return { action: "review", reason: target.wait };

  // The summary stands as the AI wrote it; the log says so.
  await prisma.$transaction([
    prisma.storedFile.update({ where: { id: file.id }, data: { summaryConfirmedAt: new Date(), summaryConfirmedBy: ctx.email, processingStartedAt: null } }),
    prisma.auditLog.create({
      data: { orgId: ctx.orgId, userEmail: ctx.email, action: "file.summary", targetType: "file", targetId: file.id, after: { name: file.name, source: "ai", edited: false, auto: true } },
    }),
  ]);
  await reindexFile(prisma, file.id);
  const unsure = await fileByAi(prisma, ctx, { fileId: file.id, destination: target.destination, seenAs: target.seenAs });
  return {
    action: "filed",
    path: target.path,
    confidence: target.confidence,
    newParty: target.newParty && target.destination.kind !== "folder" ? target.destination.partyName : null,
    unsure,
  };
}
