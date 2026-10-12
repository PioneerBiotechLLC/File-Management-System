"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { UserError } from "@/lib/errors";
import { createFolder, grantAccess, revokeAccess, setFolderActive, updateFolder } from "@/lib/folder-admin";
import { assertCan } from "@/lib/permissions";
import { companyContext } from "@/lib/session";
import type { ActionState } from "./actions";

/** Admins only. The company and acting user come from the session. */
async function adminContext(slug: string) {
  const { org, role, user } = await companyContext(slug);
  assertCan(role, "folder.manage");
  return { orgId: org.id, email: user.email };
}

async function attempt(slug: string, ok: string, work: () => Promise<void>): Promise<ActionState> {
  try {
    await work();
    revalidatePath(`/c/${slug}`, "layout");
    return { ok };
  } catch (error) {
    if (error instanceof UserError) return { error: error.message };
    throw error;
  }
}

const text = (formData: FormData, key: string) => String(formData.get(key) ?? "");

function folderFields(formData: FormData) {
  return {
    name: text(formData, "name"),
    nameAr: text(formData, "nameAr"),
    description: text(formData, "description"),
    access: formData.get("restricted") === "on" ? ("restricted" as const) : ("everyone" as const),
    parentId: text(formData, "parentId") || null,
  };
}

export async function createFolderAction(slug: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await adminContext(slug);
  return attempt(slug, "Folder created.", async () => void (await createFolder(db(), actor, folderFields(formData))));
}

export async function saveFolderAction(slug: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await adminContext(slug);
  const folderId = z.string().min(1).parse(text(formData, "folderId"));
  return attempt(slug, "Saved.", () => updateFolder(db(), actor, folderId, folderFields(formData)));
}

export async function toggleFolderAction(slug: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await adminContext(slug);
  const folderId = z.string().min(1).parse(text(formData, "folderId"));
  const active = text(formData, "active") === "1";
  return attempt(slug, active ? "Folder reactivated." : "Folder deactivated.", () => setFolderActive(db(), actor, folderId, active));
}

export async function grantAction(slug: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await adminContext(slug);
  const input = z.object({ folderId: z.string().min(1), userId: z.string().min(1) }).safeParse({ folderId: text(formData, "folderId"), userId: text(formData, "userId") });
  if (!input.success) return { error: "Choose a person." };
  return attempt(slug, "Access granted.", () => grantAccess(db(), actor, { ...input.data, canWrite: formData.get("canWrite") === "on" }));
}

export async function revokeAction(slug: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await adminContext(slug);
  const input = z.object({ folderId: z.string().min(1), userId: z.string().min(1) }).parse({ folderId: text(formData, "folderId"), userId: text(formData, "userId") });
  return attempt(slug, "Access removed.", () => revokeAccess(db(), actor, input));
}
