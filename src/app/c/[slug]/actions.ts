"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { run } from "@/lib/action-result";
import { db } from "@/lib/db";
import * as files from "@/lib/files";
import { companyContext } from "@/lib/session";

/** The company, user and role come from the session; the slug only says which company is open. */
async function context(slug: string) {
  const { org, role, user } = await companyContext(slug);
  return files.fileContext(db(), { orgId: org.id, userId: user.id, email: user.email, role });
}

function refresh(slug: string) {
  revalidatePath(`/c/${slug}`, "layout");
}

const id = z.string().min(1);

export async function startUploadAction(slug: string, input: files.StartUploadInput) {
  return run(async () => files.startUpload(db(), await context(slug), input));
}

export async function confirmUploadAction(slug: string, input: { fileId: string; versionNo: number }) {
  return run(async () => {
    const parsed = z.object({ fileId: id, versionNo: z.number().int().positive() }).parse(input);
    const result = await files.confirmUpload(db(), await context(slug), parsed);
    refresh(slug);
    return result;
  });
}

export async function moveFileAction(slug: string, input: { fileId: string; folderId: string }) {
  return run(async () => {
    const parsed = z.object({ fileId: id, folderId: id }).parse(input);
    await files.moveFile(db(), await context(slug), parsed);
    refresh(slug);
  });
}

export async function renameFileAction(slug: string, input: { fileId: string; name: string }) {
  return run(async () => {
    await files.renameFile(db(), await context(slug), input);
    refresh(slug);
  });
}

export async function updateDetailsAction(slug: string, input: Parameters<typeof files.updateFileDetails>[2]) {
  return run(async () => {
    await files.updateFileDetails(db(), await context(slug), input);
    refresh(slug);
  });
}

export async function deleteFileAction(slug: string, input: { fileId: string }) {
  return run(async () => {
    await files.deleteFile(db(), await context(slug), input);
    refresh(slug);
  });
}

export async function restoreFileAction(slug: string, input: { fileId: string }) {
  return run(async () => {
    await files.restoreFile(db(), await context(slug), input);
    refresh(slug);
  });
}
