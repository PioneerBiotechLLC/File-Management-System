import Anthropic from "@anthropic-ai/sdk";
import { AnalysisError, analysisFromMessage, buildAnalysisRequest } from "@/lib/analysis";
import { anthropic, usageOf } from "@/lib/ai";
import { autoFileAfterRead } from "@/lib/bulk";
import type { Db } from "@/lib/db";
import { aiEnv, limitsEnv } from "@/lib/env";
import { UserError } from "@/lib/errors";
import { extract } from "@/lib/extract";
import { fileContext, type FileContext } from "@/lib/files";
import { NOT_THE_UPLOAD, folderChoices, materialChoices, partyChoices, recordAnalysis, recordNotRead } from "@/lib/intake";
import { listMaterials, listParties } from "@/lib/parties";
import { getObject, head, objectKey } from "@/lib/storage";
import type { Role } from "@/generated/prisma/enums";

/**
 * Batch reading: a bulk upload can leave its files for Anthropic's Message Batches API, which
 * reads them at half price and returns the results within 24 hours (usually within the hour).
 *
 * 1. queueForBatch marks an uploaded file as waiting (it stays "processing", unfiled).
 * 2. submitBatch sends waiting files, a batch at a time, with the same request a live read sends.
 * 3. collectBatches takes the results of finished batches and stores each one exactly as a live
 *    read would, then files it with no one confirming when the AI was sure enough (bulk.ts).
 * The bulk page drives 2 and 3 while it is open; runBatchWork does the same from the cron, from
 * the Review page whenever an admin opens it, and from its "Send and check now" button. All of it
 * is bounded by a deadline and resumable: a run cut short leaves nothing claimed, and the next run
 * carries on where it stopped.
 */

/** Batch requests cost half the usual price. */
export const BATCH_DISCOUNT = 0.5;
/** Per batch: kept small so one request loads, sends and later files comfortably inside one function run. */
const BATCH_MAX_FILES = 100;
const BATCH_MAX_BYTES = 40 * 1024 * 1024;
const LOAD_LANES = 6;
/** A collection that has run this long without finishing is taken as dead and may be taken over. */
const STALE_COLLECTING_MS = 10 * 60 * 1000;
/** A batch still being put together after this was cut off before Anthropic took it. */
const STALE_SUBMITTING_MS = 15 * 60 * 1000;

type Company = { name: string; domain: string; timezone: string };

const waitingToSend = (orgId: string) => ({ orgId, status: "processing" as const, deletedAt: null, folderId: null, batchQueuedAt: { not: null }, aiBatchId: null });

/** Leaves a freshly uploaded file for batch reading instead of reading it now. Admins only, as bulk upload is. */
export async function queueForBatch(prisma: Db, ctx: Pick<FileContext, "orgId" | "role">, fileId: string): Promise<void> {
  if (ctx.role !== "admin") throw new UserError("Only admins can use batch reading.");
  const queued = await prisma.storedFile.updateMany({
    where: { id: fileId, orgId: ctx.orgId, status: "processing", deletedAt: null, folderId: null, batchQueuedAt: null, aiBatchId: null, processingStartedAt: null },
    data: { batchQueuedAt: new Date() },
  });
  if (queued.count === 0) throw new UserError("That file is not waiting to be read.");
}

export type BatchStatus = {
  waiting: number;
  reading: number;
  batches: number;
  /** When the oldest batch still with the AI was sent (ISO), for "since …" */
  oldestSentAt: string | null;
  /** Why the latest batch of the past week failed, if one did */
  lastError: string | null;
};

/** How many files wait to be sent, how many are with the AI, and how many batches are out. */
export async function batchStatus(prisma: Db, orgId: string): Promise<BatchStatus> {
  const [waiting, reading, batches, oldest, failed] = await Promise.all([
    prisma.storedFile.count({ where: waitingToSend(orgId) }),
    prisma.storedFile.count({ where: { orgId, status: "processing", deletedAt: null, batchQueuedAt: { not: null }, aiBatchId: { not: null } } }),
    prisma.aiBatch.count({ where: { orgId, status: { in: ["in_progress", "collecting"] } } }),
    prisma.aiBatch.findFirst({ where: { orgId, status: { in: ["in_progress", "collecting"] } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
    prisma.aiBatch.findFirst({ where: { orgId, status: "failed", error: { not: null }, createdAt: { gte: new Date(Date.now() - 7 * 24 * 3_600_000) } }, orderBy: { createdAt: "desc" }, select: { error: true } }),
  ]);
  return { waiting, reading, batches, oldestSentAt: oldest?.createdAt.toISOString() ?? null, lastError: failed?.error ?? null };
}

const past = (deadlineAt: Date | undefined) => !!deadlineAt && Date.now() >= deadlineAt.getTime();

/**
 * A file the AI did not read is settled as in bulk upload: too large → General under its own name,
 * unreadable → deleted. Returns what happened, or null when it stays in Review.
 */
async function settleUnread(prisma: Db, ctx: FileContext, company: { timezone: string }, fileId: string): Promise<"filed" | "deleted" | null> {
  if (ctx.role !== "admin") return null;
  const done = await autoFileAfterRead(prisma, ctx, company, fileId).catch((error: unknown) => {
    if (error instanceof UserError) return null;
    throw error;
  });
  return done?.action === "deleted" || done?.action === "filed" ? done.action : null;
}

export type SubmitResult = {
  sent: number;
  /** settled without the AI: too large (to General) or unreadable (deleted) */
  notRead: number;
  deleted: number;
  waiting: number;
};

/**
 * Sends the next batch of waiting files. Returns how many went, how many were settled without the
 * AI, and how many still wait. Past the deadline, files not loaded yet go back to waiting.
 */
export async function submitBatch(prisma: Db, ctx: FileContext, company: Company, opts: { deadlineAt?: Date } = {}): Promise<SubmitResult> {
  if (ctx.role !== "admin") throw new UserError("Only admins can use batch reading.");
  if (!process.env.ANTHROPIC_API_KEY?.trim() || aiEnv().AI_MAX_CALLS_PER_DAY <= 0) throw new UserError("AI reading is not set up on this server.");
  const model = aiEnv().ANTHROPIC_MODEL;
  const clear = { batchQueuedAt: null, attempts: { increment: 1 } };
  let notRead = 0;
  let deleted = 0;

  // Files the AI never reads are settled now rather than sent.
  const maxAiBytes = limitsEnv().FILES_AI_MAX_MB * 1024 * 1024;
  const candidates = await prisma.storedFile.findMany({
    where: waitingToSend(ctx.orgId),
    select: { id: true, name: true, originalName: true, mimeType: true, sizeBytes: true, currentVersion: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: BATCH_MAX_FILES * 3,
  });
  const chosen: typeof candidates = [];
  let bytes = 0;
  for (const file of candidates) {
    if (file.sizeBytes > maxAiBytes) {
      await recordNotRead(prisma, ctx, file, `The file is larger than ${limitsEnv().FILES_AI_MAX_MB} MB, the most the AI reads.`, false, clear);
      if ((await settleUnread(prisma, ctx, company, file.id)) === "deleted") deleted += 1;
      notRead += 1;
      continue;
    }
    if (chosen.length >= BATCH_MAX_FILES || (chosen.length > 0 && bytes + file.sizeBytes > BATCH_MAX_BYTES)) break;
    chosen.push(file);
    bytes += file.sizeBytes;
  }
  if (chosen.length === 0) return { sent: 0, notRead, deleted, waiting: await prisma.storedFile.count({ where: waitingToSend(ctx.orgId) }) };

  // Claim the files for this batch, so a second sender (the cron, another tab) cannot send them too.
  const batch = await prisma.aiBatch.create({ data: { orgId: ctx.orgId, model, createdBy: ctx.userId }, select: { id: true } });
  await prisma.storedFile.updateMany({ where: { ...waitingToSend(ctx.orgId), id: { in: chosen.map((f) => f.id) } }, data: { aiBatchId: batch.id } });
  const mine = new Set((await prisma.storedFile.findMany({ where: { aiBatchId: batch.id, status: "processing" }, select: { id: true } })).map((f) => f.id));

  const [parties, materials] = await Promise.all([listParties(prisma, ctx.orgId), listMaterials(prisma, ctx.orgId)]);
  const choices = { folders: folderChoices(ctx), parties: partyChoices(parties), materials: materialChoices(materials) };
  const requests: Anthropic.Beta.Messages.BatchCreateParams.Request[] = [];

  let cursor = 0;
  const files = chosen.filter((f) => mine.has(f.id));
  const lane = async () => {
    while (cursor < files.length && !past(opts.deadlineAt)) {
      const file = files[cursor++]!;
      // The stored object must still be the one that was checked at upload before it is loaded whole.
      const key = objectKey(ctx.orgId, file.id, file.currentVersion);
      const stored = await head(key);
      const loaded = stored && stored.sizeBytes === file.sizeBytes ? await getObject(key) : null;
      if (!loaded) {
        await recordNotRead(prisma, ctx, file, stored ? NOT_THE_UPLOAD : "The file was not found in storage.", !stored, clear);
        notRead += 1;
        continue;
      }
      const extraction = await extract(loaded, file.originalName, file.mimeType);
      if (extraction.kind === "unreadable") {
        await recordNotRead(prisma, ctx, file, extraction.reason, false, clear);
        if ((await settleUnread(prisma, ctx, company, file.id)) === "deleted") deleted += 1;
        notRead += 1;
        continue;
      }
      // The request a live read sends, without server-side fallbacks, which the Batches API does not take.
      const params = buildAnalysisRequest({ model, company, ...choices, fileName: file.originalName, uploadedAt: file.createdAt, extraction });
      // A text file cut short is marked in the id, so its result is stored as a partial read.
      requests.push({ custom_id: extraction.readStatus === "partial" ? `${file.id}_p` : file.id, params });
    }
  };
  await Promise.all(Array.from({ length: LOAD_LANES }, lane));
  // Files the deadline left unloaded wait for the next batch; the ones settled above are no longer "processing".
  const inBatch = new Set(requests.map((r) => r.custom_id.split("_")[0]!));
  const unloaded = files.filter((f) => !inBatch.has(f.id)).map((f) => f.id);
  if (unloaded.length) await prisma.storedFile.updateMany({ where: { id: { in: unloaded }, aiBatchId: batch.id, status: "processing" }, data: { aiBatchId: null } });

  if (requests.length === 0) {
    await prisma.aiBatch.update({ where: { id: batch.id }, data: { status: "ended", endedAt: new Date() } });
  } else {
    try {
      const created = await anthropic().beta.messages.batches.create({ requests });
      await prisma.aiBatch.update({ where: { id: batch.id }, data: { anthropicId: created.id, status: "in_progress", fileCount: requests.length } });
    } catch (error) {
      // Nothing was sent: the files go back to waiting for the next try.
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      await prisma.storedFile.updateMany({ where: { aiBatchId: batch.id, status: "processing" }, data: { aiBatchId: null } });
      await prisma.aiBatch.update({ where: { id: batch.id }, data: { status: "failed", error: message, endedAt: new Date() } });
      throw new UserError(`Anthropic did not accept the batch: ${message}`);
    }
  }
  return { sent: requests.length, notRead, deleted, waiting: await prisma.storedFile.count({ where: waitingToSend(ctx.orgId) }) };
}

/** A send that was cut off before Anthropic took the batch: its files go back to waiting. */
async function releaseAbandoned(prisma: Db, orgId?: string): Promise<void> {
  const abandoned = await prisma.aiBatch.findMany({
    where: { ...(orgId ? { orgId } : {}), status: "submitting", createdAt: { lt: new Date(Date.now() - STALE_SUBMITTING_MS) } },
    select: { id: true },
  });
  for (const batch of abandoned) {
    await prisma.storedFile.updateMany({ where: { aiBatchId: batch.id, status: "processing" }, data: { aiBatchId: null } });
    await prisma.aiBatch.update({ where: { id: batch.id }, data: { status: "failed", error: "Cut off before it was sent", endedAt: new Date() } });
  }
}

export type CollectResult = { checked: number; finished: number; read: number; filed: number; review: number; deleted: number; partial: boolean };

/** The admin who sent a batch, as a file context; their results are filed as them. */
async function senderContext(prisma: Db, orgId: string, userId: string): Promise<FileContext> {
  const [user, membership] = await Promise.all([
    prisma.appUser.findUnique({ where: { id: userId }, select: { email: true, isOwner: true } }),
    prisma.membership.findUnique({ where: { userId_orgId: { userId, orgId } }, select: { role: true } }),
  ]);
  const role: Role = membership?.role ?? (user?.isOwner ? "admin" : "viewer");
  return fileContext(prisma, { orgId, userId, email: user?.email ?? "system", role });
}

/**
 * Takes in the results of batches Anthropic has finished: each file is stored as a live read would
 * store it, then filed when the AI was sure enough. Batches still running are only checked.
 */
export async function collectBatches(prisma: Db, opts: { orgId?: string; limit?: number; deadlineAt?: Date } = {}): Promise<CollectResult> {
  const out: CollectResult = { checked: 0, finished: 0, read: 0, filed: 0, review: 0, deleted: 0, partial: false };
  await releaseAbandoned(prisma, opts.orgId);
  const stale = new Date(Date.now() - STALE_COLLECTING_MS);
  const open = await prisma.aiBatch.findMany({
    where: {
      ...(opts.orgId ? { orgId: opts.orgId } : {}),
      anthropicId: { not: null },
      OR: [{ status: "in_progress" }, { status: "collecting", checkedAt: { lt: stale } }],
    },
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? 3,
  });

  for (const batch of open) {
    if (past(opts.deadlineAt)) {
      out.partial = true;
      break;
    }
    out.checked += 1;
    const remote = await anthropic().beta.messages.batches.retrieve(batch.anthropicId!);
    if (remote.processing_status !== "ended") {
      await prisma.aiBatch.update({ where: { id: batch.id }, data: { checkedAt: new Date() } });
      continue;
    }
    // Take it, so two collectors never store the same results twice.
    const claimed = await prisma.aiBatch.updateMany({
      where: { id: batch.id, OR: [{ status: "in_progress" }, { status: "collecting", checkedAt: { lt: stale } }] },
      data: { status: "collecting", checkedAt: new Date() },
    });
    if (claimed.count === 0) continue;

    const [org, ctx] = await Promise.all([
      prisma.organization.findUniqueOrThrow({ where: { id: batch.orgId }, select: { name: true, domain: true, timezone: true } }),
      senderContext(prisma, batch.orgId, batch.createdBy),
    ]);
    const [parties, materials] = await Promise.all([listParties(prisma, batch.orgId), listMaterials(prisma, batch.orgId)]);
    const choices = { folders: folderChoices(ctx), parties: partyChoices(parties), materials: materialChoices(materials) };
    const clear = { batchQueuedAt: null, attempts: { increment: 1 } };

    for await (const entry of await anthropic().beta.messages.batches.results(batch.anthropicId!)) {
      if (past(opts.deadlineAt)) {
        // Hand the batch back: the files stored so far stay stored, the next run takes the rest at once.
        await prisma.aiBatch.update({ where: { id: batch.id }, data: { status: "in_progress", checkedAt: new Date() } });
        out.partial = true;
        return out;
      }
      const [fileId, flag] = entry.custom_id.split("_");
      const file = await prisma.storedFile.findFirst({
        where: { id: fileId, orgId: batch.orgId, aiBatchId: batch.id, status: "processing", deletedAt: null },
        select: { id: true, name: true },
      });
      if (!file) continue; // Deleted meanwhile, or already stored.
      const result = entry.result;

      if (result.type === "succeeded") {
        const message = result.message;
        const usage = usageOf(message, batch.model);
        const costUsd = usage.costUsd * BATCH_DISCOUNT;
        await prisma.aiUsage.create({
          data: {
            orgId: batch.orgId,
            userId: batch.createdBy,
            fileId: file.id,
            purpose: "file_analysis",
            model: message.model,
            inputTokens: usage.input,
            outputTokens: usage.output,
            cacheReadTokens: usage.cacheRead,
            cacheWriteTokens: usage.cacheWrite,
            costUsd,
            finishedAt: new Date(),
            error: message.stop_reason === "refusal" ? "refused" : null,
          },
        });
        let outcome;
        try {
          outcome = analysisFromMessage(message, choices, flag === "p" ? "partial" : "full");
        } catch (error) {
          if (!(error instanceof AnalysisError)) throw error;
          await recordNotRead(prisma, ctx, file, `AI reading failed: ${error.message}`, true, clear);
          out.review += 1;
          continue;
        }
        if (outcome.status !== "analyzed") {
          await recordNotRead(prisma, ctx, file, outcome.reason, false, clear);
          out[(await settleUnread(prisma, ctx, org, file.id)) ?? "review"] += 1;
          continue;
        }
        const read = await recordAnalysis(prisma, ctx, file, outcome, costUsd, clear);
        if (read.status !== "read") {
          out.review += 1;
          continue;
        }
        out.read += 1;
        if (ctx.role !== "admin") {
          out.review += 1;
          continue;
        }
        try {
          const filed = await autoFileAfterRead(prisma, ctx, org, file.id);
          out[filed.action === "filed" ? "filed" : filed.action === "deleted" ? "deleted" : "review"] += 1;
        } catch (error) {
          if (!(error instanceof UserError)) throw error;
          out.review += 1;
        }
      } else if (result.type === "errored") {
        // A request Claude rejects (a damaged or oversized PDF) is the file's doing; anything else may work next time.
        const invalid = result.error.error.type === "invalid_request_error";
        const reason = invalid ? `Claude could not read this file: ${result.error.error.message.slice(0, 200)}` : `Batch reading failed (${result.error.error.type}); try again with AI.`;
        await recordNotRead(prisma, ctx, file, reason, !invalid, clear);
        out[(invalid && (await settleUnread(prisma, ctx, org, file.id))) || "review"] += 1;
      } else {
        await recordNotRead(prisma, ctx, file, "Batch reading did not finish in time; try again with AI.", true, clear);
        out.review += 1;
      }
    }

    // Anything the results left out is not lost: it waits in Review, ready to try again.
    const missing = await prisma.storedFile.findMany({ where: { aiBatchId: batch.id, status: "processing", deletedAt: null }, select: { id: true, name: true } });
    for (const file of missing) {
      await recordNotRead(prisma, ctx, file, "No result came back from batch reading; try again with AI.", true, clear);
      out.review += 1;
    }
    await prisma.aiBatch.update({ where: { id: batch.id }, data: { status: "ended", endedAt: new Date() } });
    out.finished += 1;
  }
  return out;
}

/** Sends waiting files, batch after batch, as the admin who uploaded them, until none wait or the deadline passes. */
export async function submitWaiting(prisma: Db, opts: { orgId?: string; deadlineAt?: Date } = {}): Promise<number> {
  let sent = 0;
  while (!past(opts.deadlineAt)) {
    const next = await prisma.storedFile.findFirst({
      where: { ...(opts.orgId ? { orgId: opts.orgId } : {}), status: "processing", deletedAt: null, folderId: null, batchQueuedAt: { not: null }, aiBatchId: null },
      select: { orgId: true, uploadedBy: true, org: { select: { name: true, domain: true, timezone: true } } },
      orderBy: { batchQueuedAt: "asc" },
    });
    if (!next) break;
    const ctx = await senderContext(prisma, next.orgId, next.uploadedBy);
    if (ctx.role !== "admin") break;
    const r = await submitBatch(prisma, ctx, next.org, opts);
    sent += r.sent;
    if (r.sent === 0 && r.notRead === 0) break; // nothing could be loaded in the time left
  }
  return sent;
}

export type BatchWork = { collected: CollectResult; sent: number; error: string | null };

/**
 * Everything batch reading needs doing, within a time budget: finished batches in, waiting files
 * out. Run by the cron, by the Review page when an admin opens it, and by its button.
 */
export async function runBatchWork(prisma: Db, opts: { budgetMs: number; orgId?: string }): Promise<BatchWork> {
  const deadlineAt = new Date(Date.now() + opts.budgetMs);
  const out: BatchWork = { collected: { checked: 0, finished: 0, read: 0, filed: 0, review: 0, deleted: 0, partial: false }, sent: 0, error: null };
  try {
    out.collected = await collectBatches(prisma, { orgId: opts.orgId, limit: 10, deadlineAt });
    out.sent = await submitWaiting(prisma, { orgId: opts.orgId, deadlineAt });
  } catch (error) {
    out.error = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    console.error(`batch work failed: ${out.error}`);
  }
  return out;
}
