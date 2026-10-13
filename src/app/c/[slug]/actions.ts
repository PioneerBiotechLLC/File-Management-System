"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { run } from "@/lib/action-result";
import { db } from "@/lib/db";
import * as files from "@/lib/files";
import * as intake from "@/lib/intake";
import type { Destination } from "@/lib/file-kinds";
import { destinationInput, fileTo } from "@/lib/parties";
import { companyContext } from "@/lib/session";

/** The company, user and role come from the session; the slug only says which company is open. */
async function context(slug: string) {
  const { org, role, user } = await companyContext(slug);
  return files.fileContext(db(), { orgId: org.id, userId: user.id, email: user.email, role });
}

async function companyAndContext(slug: string) {
  const { org, role, user } = await companyContext(slug);
  return { org, ctx: await files.fileContext(db(), { orgId: org.id, userId: user.id, email: user.email, role }) };
}

function refresh(slug: string) {
  revalidatePath(`/c/${slug}`, "layout");
}

const id = z.string().min(1);

/** Uploads from the web always go through Review; a folder cannot be chosen up front here. */
export async function startUploadAction(slug: string, input: Omit<files.StartUploadInput, "folderId">) {
  return run(async () => files.startUpload(db(), await context(slug), { ...input, folderId: null }));
}

export async function confirmUploadAction(slug: string, input: { fileId: string; versionNo: number }) {
  return run(async () => {
    const parsed = z.object({ fileId: id, versionNo: z.number().int().positive() }).parse(input);
    const result = await files.confirmUpload(db(), await context(slug), parsed);
    refresh(slug);
    return result;
  });
}

/** Step 2 of filing: the uploader's checked summary. Returns the AI's folder suggestion for step 3. */
export async function confirmSummaryAction(slug: string, input: { fileId: string } & intake.SummaryFormInput) {
  return run(async () => {
    const { org, ctx } = await companyAndContext(slug);
    const result = await intake.confirmSummary(db(), ctx, org, { ...input, fileId: id.parse(input.fileId) });
    refresh(slug);
    return result;
  });
}

/** Puts a file whose AI read failed back in line; the browser then calls the analyze route again. */
export async function retryReadAction(slug: string, input: { fileId: string }) {
  return run(async () => {
    await intake.retryRead(db(), await context(slug), id.parse(input.fileId));
    refresh(slug);
  });
}

export async function moveFileAction(slug: string, input: { fileId: string; folderId: string }) {
  return run(async () => {
    const parsed = z.object({ fileId: id, folderId: id }).parse(input);
    await files.moveFile(db(), await context(slug), parsed);
    refresh(slug);
  });
}

/** Files or moves a file to a company folder, or to `<year> / Customers|Suppliers / <company> / <kind>`. */
export async function fileToAction(slug: string, input: { fileId: string; destination: Destination; seenAs?: string | null }) {
  return run(async () => {
    const parsed = z
      .object({ fileId: id, destination: destinationInput, seenAs: z.string().max(200).nullish() })
      .parse(input);
    await fileTo(db(), await context(slug), parsed);
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
