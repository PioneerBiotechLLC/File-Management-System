"use server";

import { z } from "zod";
import { db } from "@/lib/db";
import { fileContext } from "@/lib/files";
import { listRefileFiles } from "@/lib/refile";
import { REFILE_SCOPES, type RefileItem } from "@/lib/refile-scopes";
import { companyContext } from "@/lib/session";

/** The files a re-file run would look at, for the scope the admin chose. */
export async function listRefileAction(slug: string, scope: string): Promise<RefileItem[]> {
  const ctx = await companyContext(slug);
  if (ctx.role !== "admin") return [];
  const parsed = z.enum(REFILE_SCOPES.map((s) => s.id) as [string, ...string[]]).parse(scope);
  const files = await fileContext(db(), { orgId: ctx.org.id, userId: ctx.user.id, email: ctx.user.email, role: ctx.role });
  return listRefileFiles(db(), files, parsed as (typeof REFILE_SCOPES)[number]["id"]);
}
