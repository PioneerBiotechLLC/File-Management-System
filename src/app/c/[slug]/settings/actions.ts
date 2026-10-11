"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { assertCan } from "@/lib/permissions";
import { companyContext } from "@/lib/session";
import { UserError } from "@/lib/errors";
import { addMember, changeMemberRole, emailSchema, removeMember, roleSchema } from "@/lib/users";

export type ActionState = { ok?: string; error?: string } | null;

/** The company and acting user come from the session; the slug only says which company is open. */
async function adminContext(slug: string) {
  const ctx = await companyContext(slug);
  assertCan(ctx.role, "user.manage");
  return { ...ctx, actor: { email: ctx.user.email, userId: ctx.user.id } };
}

function failed(error: unknown): ActionState {
  if (error instanceof UserError) return { error: error.message };
  throw error;
}

const addInput = z.object({ email: emailSchema, role: roleSchema });
const roleInput = z.object({ userId: z.string().min(1), role: roleSchema });
const removeInput = z.object({ userId: z.string().min(1) });

export async function addMemberAction(slug: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await adminContext(slug);
  const input = addInput.safeParse(Object.fromEntries(formData));
  if (!input.success) return { error: "Enter a valid email address and choose a role." };
  try {
    const { change } = await addMember(db(), { orgId: ctx.org.id, ...input.data, actor: ctx.actor });
    revalidatePath(`/c/${slug}/settings`);
    const { email, role } = input.data;
    return { ok: change === "unchanged" ? `${email} is already ${role}.` : change === "added" ? `Added ${email} as ${role}.` : `${email} is now ${role}.` };
  } catch (error) {
    return failed(error);
  }
}

export async function changeRoleAction(slug: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await adminContext(slug);
  const input = roleInput.safeParse(Object.fromEntries(formData));
  if (!input.success) return { error: "Choose a role." };
  try {
    await changeMemberRole(db(), { orgId: ctx.org.id, ...input.data, actor: ctx.actor });
    revalidatePath(`/c/${slug}/settings`);
    return { ok: "Role updated." };
  } catch (error) {
    return failed(error);
  }
}

export async function removeMemberAction(slug: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await adminContext(slug);
  const input = removeInput.safeParse(Object.fromEntries(formData));
  if (!input.success) return { error: "Nobody selected." };
  try {
    await removeMember(db(), { orgId: ctx.org.id, ...input.data, actor: ctx.actor });
    revalidatePath(`/c/${slug}/settings`);
    return { ok: "Removed." };
  } catch (error) {
    return failed(error);
  }
}
