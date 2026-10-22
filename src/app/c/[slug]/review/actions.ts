"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { run } from "@/lib/action-result";
import { runBatchWork } from "@/lib/batch-reading";
import { settleReview } from "@/lib/bulk";
import { db } from "@/lib/db";
import { UserError } from "@/lib/errors";
import { fileContext } from "@/lib/files";
import { companyContext } from "@/lib/session";

/** Files settled per call, and the time one call may take (the route allows 120 s): what is left waits for the next call. */
const PER_CALL = 25;
const CALL_BUDGET_MS = 90_000;

/** Clears Review the way bulk upload files; called again with `next` until it is null. */
export async function settleReviewAction(slug: string, after: string | null) {
  return run(async () => {
    const { org, role, user } = await companyContext(slug);
    if (role !== "admin") throw new UserError("Only admins can clear Review.");
    const ctx = await fileContext(db(), { orgId: org.id, userId: user.id, email: user.email, role });
    const out = await settleReview(db(), ctx, org, { after: z.string().nullable().parse(after) || null, limit: PER_CALL, deadlineAt: new Date(Date.now() + CALL_BUDGET_MS) });
    if (out.next === null) revalidatePath(`/c/${slug}`, "layout");
    return out;
  });
}

/** Batch reading, right now: finished batches in, waiting files out, within this route's time. */
export async function checkBatchesAction(slug: string) {
  return run(async () => {
    const { org, role } = await companyContext(slug);
    if (role !== "admin") throw new UserError("Only admins can check batch reading.");
    const result = await runBatchWork(db(), { budgetMs: 90_000, orgId: org.id });
    revalidatePath(`/c/${slug}`, "layout");
    return result;
  });
}
