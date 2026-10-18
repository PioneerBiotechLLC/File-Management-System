import { analyzeFile, filingIsUsable } from "@/lib/analysis";
import { AUTO_FILE_THRESHOLD, autoFileAfterRead, autoFileTarget, fileByAi } from "@/lib/bulk";
import type { Db } from "@/lib/db";
import { aiEnv, limitsEnv } from "@/lib/env";
import { UserError } from "@/lib/errors";
import { extract } from "@/lib/extract";
import { checkCanMove, type FileContext } from "@/lib/files";
import { folderChoices, materialChoices, partyChoices, storedFiling } from "@/lib/intake";
import { yearChoice, listMaterials, listParties, suggestionFor } from "@/lib/parties";
import type { RefileItem, RefileScope } from "@/lib/refile-scopes";
import { reindexFile } from "@/lib/search-index";
import { getObject, head, objectKey } from "@/lib/storage";

/**
 * Re-filing files that are already in the system: the AI reads the stored file again with the
 * current filing rules and, when it is sure enough, moves it. Nothing is uploaded again.
 */

/** Moving a filed file needs a little more certainty than filing a new one. */
export const REFILE_THRESHOLD = 0.6;
const MAX_FILES = 3_000;

export type RefileOutcome =
  | { status: "moved" | "preview"; from: string; to: string; confidence: number }
  | { status: "unchanged"; at: string }
  | { status: "kept"; at: string; reason: string }
  | { status: "skipped"; reason: string }
  | { status: "busy" };

export async function listRefileFiles(prisma: Db, ctx: FileContext, scope: RefileScope): Promise<RefileItem[]> {
  if (ctx.role !== "admin") throw new UserError("Only admins can re-file.");
  const select = { id: true, name: true, folderId: true } as const;
  const base = { orgId: ctx.orgId, deletedAt: null } as const;
  const kinds = { technical: "tech_doc", commercial: "doc", company: "regular" } as const;
  const rows =
    scope === "review"
      ? await prisma.storedFile.findMany({
          where: { ...base, folderId: null, status: "needs_review", summaryConfirmedAt: null, readStatus: { in: ["full", "partial"] } },
          select,
          orderBy: { createdAt: "asc" },
          take: MAX_FILES,
        })
      : await prisma.storedFile.findMany({
          where: { ...base, status: "ready", folderId: { in: ctx.folders.filter((f) => f.kind === kinds[scope] && ctx.visible.has(f.id)).map((f) => f.id) } },
          select,
          orderBy: { createdAt: "asc" },
          take: MAX_FILES,
        });
  return rows.map((r) => ({ id: r.id, name: r.name, path: r.folderId ? (ctx.paths.get(r.folderId) ?? "") : "Review" }));
}

type Company = { name: string; domain: string; timezone: string };

export async function refileOne(prisma: Db, ctx: FileContext, company: Company, fileId: string, opts: { apply: boolean }): Promise<RefileOutcome> {
  if (ctx.role !== "admin") throw new UserError("Only admins can re-file.");
  const file = await prisma.storedFile.findFirst({
    where: { id: fileId, orgId: ctx.orgId, deletedAt: null, status: { in: ["ready", "needs_review"] } },
    select: { id: true, originalName: true, mimeType: true, sizeBytes: true, currentVersion: true, folderId: true, docDate: true, createdAt: true, summaryConfirmedAt: true },
  });
  if (!file) throw new UserError("That file was not found.");
  const unfiled = file.folderId === null;
  if (unfiled && file.summaryConfirmedAt) throw new UserError("That file is waiting for its filing to be confirmed.");
  const here = file.folderId ? (ctx.paths.get(file.folderId) ?? "") : "Review";

  const maxMb = limitsEnv().FILES_AI_MAX_MB;
  if (file.sizeBytes > maxMb * 1024 * 1024) return { status: "skipped", reason: `Larger than ${maxMb} MB, the most the AI reads.` };
  const key = objectKey(ctx.orgId, file.id, file.currentVersion);
  const stored = await head(key);
  const bytes = stored && stored.sizeBytes === file.sizeBytes ? await getObject(key) : null;
  if (!bytes) return { status: "skipped", reason: "The stored file was not found." };

  const [parties, materials] = await Promise.all([listParties(prisma, ctx.orgId), listMaterials(prisma, ctx.orgId)]);
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
        parties: partyChoices(parties),
        materials: materialChoices(materials),
        fileName: file.originalName,
        uploadedAt: file.createdAt,
        extraction,
      },
    );
  } catch (error) {
    return { status: "skipped", reason: `AI reading failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}` };
  }
  if (outcome.status === "limit_reached" && outcome.limit === "user_busy") return { status: "busy" };
  if (outcome.status !== "analyzed") return { status: "skipped", reason: outcome.reason };
  const { analysis } = outcome;
  if (!analysis.readable || !filingIsUsable(analysis.filing)) return { status: "kept", at: here, reason: analysis.problem ?? "The AI could not tell where it belongs." };

  const year = yearChoice(file.docDate ?? analysis.docDate, file.createdAt, company.timezone);
  const filing = storedFiling(analysis.filing);
  const suggestion = suggestionFor(
    { folderId: filing.suggestedFolderId, trading: filing.suggestedTrading, confidence: filing.filingConfidence, reason: filing.filingReason },
    ctx,
    parties,
    year,
    materials,
  );
  // A filed file is only moved to a place the AI names; one waiting in Review may go to General, as in bulk upload.
  const target = autoFileTarget(suggestion, filing.filingConfidence, ctx, { threshold: unfiled ? AUTO_FILE_THRESHOLD : REFILE_THRESHOLD, general: unfiled });
  if ("wait" in target) return { status: "kept", at: here, reason: target.wait };
  if (target.path === here) return { status: "unchanged", at: here };
  if (!opts.apply) return { status: "preview", from: here, to: target.path, confidence: target.confidence };

  if (unfiled) {
    await prisma.storedFile.update({ where: { id: file.id }, data: filing });
    const done = await autoFileAfterRead(prisma, ctx, company, file.id);
    return done.action === "filed" ? { status: "moved", from: here, to: done.path, confidence: done.confidence } : { status: "kept", at: here, reason: done.reason };
  }
  await checkCanMove(prisma, ctx, file.id);
  await fileByAi(prisma, ctx, { fileId: file.id, destination: target.destination, seenAs: target.seenAs });
  await reindexFile(prisma, file.id);
  return { status: "moved", from: here, to: target.path, confidence: target.confidence };
}
