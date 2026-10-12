"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { run } from "@/lib/action-result";
import { setCompanyLimits, setMemberLimits } from "@/lib/ai-limits";
import { db } from "@/lib/db";
import { assertCan } from "@/lib/permissions";
import { companyContext } from "@/lib/session";

/** An empty field means "use the default". */
const usd = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : Number(v.replaceAll(",", ""))));

const limitsInput = z.object({ dailyUsd: usd, monthlyUsd: usd });

async function adminActor(slug: string) {
  const { org, role, user } = await companyContext(slug);
  assertCan(role, "settings.manage");
  return { orgId: org.id, email: user.email };
}

export async function setMemberLimitsAction(slug: string, input: { userId: string; dailyUsd: string; monthlyUsd: string }) {
  return run(async () => {
    const actor = await adminActor(slug);
    await setMemberLimits(db(), actor, { userId: z.string().min(1).parse(input.userId), ...limitsInput.parse(input) });
    revalidatePath(`/c/${slug}/usage`);
  });
}

export async function setCompanyLimitsAction(slug: string, input: { dailyUsd: string; monthlyUsd: string }) {
  return run(async () => {
    const actor = await adminActor(slug);
    await setCompanyLimits(db(), actor, limitsInput.parse(input));
    revalidatePath(`/c/${slug}/usage`);
  });
}
