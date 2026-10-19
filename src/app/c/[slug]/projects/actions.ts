"use server";

import { z } from "zod";
import { run } from "@/lib/action-result";
import { db } from "@/lib/db";
import { UserError } from "@/lib/errors";
import { fileContext, startUpload } from "@/lib/files";
import { ensureProjectFolders } from "@/lib/projects";
import { companyContext } from "@/lib/session";

async function adminContext(slug: string) {
  const { org, role, user } = await companyContext(slug);
  if (role !== "admin") throw new UserError("Only admins can upload projects.");
  return fileContext(db(), { orgId: org.id, userId: user.id, email: user.email, role });
}

/** Creates the folders a picked project needs, below Projects or one of its folders. */
export async function ensureProjectFoldersAction(slug: string, input: { parentId: string | null; paths: string[] }) {
  return run(async () => {
    const parsed = z.object({ parentId: z.string().min(1).nullable(), paths: z.array(z.string().min(1).max(2_000)).max(500) }).parse(input);
    return ensureProjectFolders(db(), await adminContext(slug), parsed);
  });
}

/**
 * Step 1 of uploading one project file: straight into its project folder, never through the AI.
 * Only an identical file already in that same folder counts as a duplicate, so a resumed upload
 * skips what is there while a project keeps its own copies of files that exist elsewhere.
 */
export async function startProjectUploadAction(slug: string, input: { name: string; size: number; mimeType: string; sha256: string; folderId: string }) {
  return run(async () => {
    const ctx = await adminContext(slug);
    if (ctx.folders.find((f) => f.id === input.folderId)?.kind !== "project") throw new UserError("That is not a project folder.");
    return startUpload(db(), ctx, { ...input, allowDuplicate: false, duplicatesIn: "folder" });
  });
}
