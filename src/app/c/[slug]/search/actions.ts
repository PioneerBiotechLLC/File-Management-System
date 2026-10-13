"use server";

import { z } from "zod";
import { run } from "@/lib/action-result";
import { ask } from "@/lib/ask";
import { db } from "@/lib/db";
import { fileContext } from "@/lib/files";
import { logSearch, searchFiles, type SearchFilters } from "@/lib/search";
import { companyContext } from "@/lib/session";

async function context(slug: string) {
  const { org, role, user } = await companyContext(slug);
  return { org, ctx: await fileContext(db(), { orgId: org.id, userId: user.id, email: user.email, role }) };
}

/** Keyword search, no AI. Each search is logged, merged with a refinement of the one before. */
export async function searchAction(slug: string, input: { q: string; filters?: SearchFilters }) {
  return run(async () => {
    const { ctx } = await context(slug);
    const q = z.string().max(300).parse(input.q);
    const result = await searchFiles(db(), ctx, { q, filters: input.filters });
    await logSearch(db(), ctx, { q, hits: result.hits.length, filters: input.filters });
    return result;
  });
}

/** AI search: deeper, within the filters the person chose. */
export async function askAction(slug: string, input: { question: string; filters?: SearchFilters }) {
  return run(async () => {
    const { org, ctx } = await context(slug);
    return ask(db(), ctx, { name: org.name, timezone: org.timezone }, z.string().max(500).parse(input.question), input.filters);
  });
}
