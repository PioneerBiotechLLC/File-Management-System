import type { Db } from "@/lib/db";
import { DOC_TYPE_LABELS, type DocType } from "@/lib/doc-types";
import { factsOf } from "@/lib/intake";
import { indexText } from "@/lib/search-text";

/**
 * What a file can be found by: its name, the confirmed summary and facts, its type and date.
 * Never anything from the file's contents. Stored as a tsvector on the file.
 */

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

type Indexable = {
  name: string;
  title: string | null;
  summary: string | null;
  docType: string | null;
  docDate: Date | null;
  facts: unknown;
  tags: string[];
};

export function indexTextFor(file: Indexable): string {
  const facts = factsOf(file.facts);
  const date = file.docDate ? `${file.docDate.toISOString().slice(0, 10)} ${file.docDate.getUTCFullYear()} ${MONTHS[file.docDate.getUTCMonth()]}` : null;
  return indexText([
    file.name,
    file.title,
    file.summary,
    file.docType ? (DOC_TYPE_LABELS[file.docType as DocType] ?? file.docType) : null,
    date,
    ...facts.parties,
    ...facts.references.map((r) => `${r.kind} ${r.value}`),
    ...facts.amounts.map((a) => `${a.value} ${a.currency}`),
    ...facts.products,
    facts.expiryDate ?? null,
    ...file.tags,
  ]);
}

const SELECT = { id: true, name: true, title: true, summary: true, docType: true, docDate: true, facts: true, tags: true } as const;

async function write(prisma: Db, file: Indexable & { id: string }): Promise<void> {
  await prisma.$executeRaw`UPDATE "StoredFile" SET "searchVector" = to_tsvector('simple', ${indexTextFor(file)}) WHERE "id" = ${file.id}`;
}

/** Rebuilds one file's search entry; call after anything searchable changes. */
export async function reindexFile(prisma: Db, fileId: string): Promise<void> {
  const file = await prisma.storedFile.findUnique({ where: { id: fileId }, select: SELECT });
  if (file) await write(prisma, file);
}

/** Rebuilds every file in a company (or everywhere), for the first deploy and after index changes. */
export async function reindexAll(prisma: Db, orgId?: string): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.storedFile.findMany({
      where: orgId ? { orgId } : {},
      select: SELECT,
      orderBy: { id: "asc" },
      take: 200,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (batch.length === 0) return count;
    for (const file of batch) await write(prisma, file);
    count += batch.length;
    cursor = batch[batch.length - 1]!.id;
  }
}
