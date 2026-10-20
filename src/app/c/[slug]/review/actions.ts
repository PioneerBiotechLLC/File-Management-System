"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { run } from "@/lib/action-result";
import { settleReview } from "@/lib/bulk";
import { db } from "@/lib/db";
import { UserError } from "@/lib/errors";
import { fileContext } from "@/lib/files";
import { companyContext } from "@/lib/session";

/** Files settled per call, so each call ends well within the time limit. */
const PER_CALL = 25;

/** Clears Review the way bulk upload files; called again with `next` until it is null. */
export async function settleReviewAction(slug: string, after: string | null) {
  return run(async () => {
    const { org, role, user } = await companyContext(slug);
    if (role !== "admin") throw new UserError("Only admins can clear Review.");
    const ctx = await fileContext(db(), { orgId: org.id, userId: user.id, email: user.email, role });
    const out = await settleReview(db(), ctx, org, { after: z.string().min(1).nullable().parse(after), limit: PER_CALL });
    if (out.next === null) revalidatePath(`/c/${slug}`, "layout");
    return out;
  });
}
