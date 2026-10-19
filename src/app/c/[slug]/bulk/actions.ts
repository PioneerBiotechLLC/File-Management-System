"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { run } from "@/lib/action-result";
import { batchStatus, collectBatches, queueForBatch, submitBatch } from "@/lib/batch-reading";
import { db } from "@/lib/db";
import { UserError } from "@/lib/errors";
import { fileContext } from "@/lib/files";
import { companyContext } from "@/lib/session";

/** Batch reading is part of bulk upload, so admins only. */
async function admin(slug: string) {
  const { org, role, user } = await companyContext(slug);
  if (role !== "admin") throw new UserError("Only admins can use batch reading.");
  return { org, ctx: await fileContext(db(), { orgId: org.id, userId: user.id, email: user.email, role }) };
}

/** After uploading: leave the file for batch reading instead of reading it now. */
export async function queueForBatchAction(slug: string, fileId: string) {
  return run(async () => {
    const { ctx } = await admin(slug);
    await queueForBatch(db(), ctx, z.string().min(1).parse(fileId));
  });
}

/** Sends the next batch of waiting files to the AI. */
export async function submitBatchAction(slug: string) {
  return run(async () => {
    const { org, ctx } = await admin(slug);
    return submitBatch(db(), ctx, org);
  });
}

/** Takes in any batch the AI has finished, then reports what is still waiting. */
export async function collectBatchesAction(slug: string) {
  return run(async () => {
    const { org } = await admin(slug);
    const collected = await collectBatches(db(), { orgId: org.id, limit: 1 });
    if (collected.finished > 0) revalidatePath(`/c/${slug}`, "layout");
    return { collected, status: await batchStatus(db(), org.id) };
  });
}

export async function batchStatusAction(slug: string) {
  return run(async () => batchStatus(db(), (await admin(slug)).org.id));
}
