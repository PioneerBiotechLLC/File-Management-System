import type { Db } from "@/lib/db";
import { UserError } from "@/lib/errors";
import type { FileContext } from "@/lib/files";
import { fileTo, yearChoice, listMaterials, listParties, suggestionFor } from "@/lib/parties";
import { reindexFile } from "@/lib/search-index";

/**
 * Bulk upload: an admin's files are filed straight after the AI reads them, with no one
 * confirming. A file is filed only when the AI read it, named somewhere it can go, and was at
 * least AUTO_FILE_THRESHOLD sure; otherwise it waits in Review like any other upload.
 */

export const AUTO_FILE_THRESHOLD = 0.5;

export type BulkOutcome =
  | { action: "filed"; path: string; confidence: number; newParty: string | null }
  | { action: "review"; reason: string };

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
  if (!suggestion) return { action: "review", reason: "The AI could not tell where it belongs." };
  if (suggestion.confidence < AUTO_FILE_THRESHOLD) {
    return { action: "review", reason: `The AI was only ${Math.round(suggestion.confidence * 100)}% sure it belongs in ${suggestion.path}.` };
  }

  // The summary stands as the AI wrote it; the log says so.
  await prisma.$transaction([
    prisma.storedFile.update({ where: { id: file.id }, data: { summaryConfirmedAt: new Date(), summaryConfirmedBy: ctx.email, processingStartedAt: null } }),
    prisma.auditLog.create({
      data: { orgId: ctx.orgId, userEmail: ctx.email, action: "file.summary", targetType: "file", targetId: file.id, after: { name: file.name, source: "ai", edited: false, auto: true } },
    }),
  ]);
  await reindexFile(prisma, file.id);
  await fileTo(prisma, ctx, { fileId: file.id, destination: suggestion.destination, seenAs: suggestion.seenAs });
  return {
    action: "filed",
    path: suggestion.path,
    confidence: suggestion.confidence,
    newParty: suggestion.newParty && suggestion.destination.kind !== "folder" ? suggestion.destination.partyName : null,
  };
}
