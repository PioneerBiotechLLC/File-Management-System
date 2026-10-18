import type { Db } from "@/lib/db";
import { DOC_TYPE_LABELS, type DocType } from "@/lib/doc-types";
import { folderPaths } from "@/lib/folders";
import type { Prisma } from "@/generated/prisma/client";
import { factsOf } from "@/lib/intake";
import { factsKey, putObject } from "@/lib/storage";

/**
 * Every confirmed file gets a small CSV beside its bytes in the bucket (`<org>/<file>/facts.csv`):
 * who it is with, what it is, its date, amounts, references, tags, and one row per line item,
 * with the file's columns repeated on each row so many of them can be stacked into one sheet.
 * It is rewritten whenever the summary, details or folder change and purged with the file. The
 * app never shows it; it is there for reports built outside the app.
 */

const SELECT = {
  id: true,
  orgId: true,
  name: true,
  title: true,
  docType: true,
  docDate: true,
  summary: true,
  facts: true,
  tags: true,
  language: true,
  createdAt: true,
  summaryConfirmedAt: true,
  summaryConfirmedBy: true,
  folderId: true,
  folder: { select: { year: true } },
  party: { select: { side: true, name: true } },
  material: { select: { name: true } },
  uploader: { select: { name: true, email: true } },
} satisfies Prisma.StoredFileSelect;

export type CsvFile = Prisma.StoredFileGetPayload<{ select: typeof SELECT }> & { folderPath: string | null };

export const CSV_COLUMNS = [
  "file_id",
  "file_name",
  "title",
  "document_type",
  "document_date",
  "side",
  "company",
  "material",
  "folder",
  "year",
  "summary",
  "parties",
  "references",
  "amounts",
  "expiry_date",
  "tags",
  "language",
  "uploaded_by",
  "uploaded_at",
  "confirmed_by",
  "confirmed_at",
  "item_no",
  "item_description",
  "quantity",
  "unit",
  "unit_price",
  "line_total",
  "currency",
] as const;

/** RFC 4180: quote a cell holding a comma, a quote or a line break; double the quotes inside. */
const cell = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const day = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;

/** The CSV text, with a BOM so Excel reads the Arabic in it. */
export function factsCsv(file: CsvFile): string {
  const facts = factsOf(file.facts);
  const base = [
    file.id,
    file.name,
    file.title,
    file.docType ? (DOC_TYPE_LABELS[file.docType as DocType] ?? file.docType) : null,
    day(file.docDate),
    file.party?.side ?? null,
    file.party?.name ?? null,
    file.material?.name ?? null,
    file.folderPath,
    file.folder?.year ?? null,
    file.summary,
    facts.parties.join("; "),
    facts.references.map((r) => `${r.kind} ${r.value}`).join("; "),
    facts.amounts.map((a) => `${a.value} ${a.currency}`).join("; "),
    facts.expiryDate ?? null,
    file.tags.join("; "),
    file.language,
    file.uploader.name ?? file.uploader.email,
    file.createdAt.toISOString(),
    file.summaryConfirmedBy,
    file.summaryConfirmedAt?.toISOString() ?? null,
  ];
  // A file without items is still one row, so every file appears in a stacked sheet.
  const rows = facts.items.length
    ? facts.items.map((item, i) => [...base, i + 1, item.description, item.quantity, item.unit, item.unitPrice, item.total, item.currency])
    : [[...base, null, null, null, null, null, null, null]];
  return `﻿${[CSV_COLUMNS, ...rows].map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
}

async function load(prisma: Db, where: Prisma.StoredFileWhereInput, take: number, cursor?: string): Promise<CsvFile[]> {
  const rows = await prisma.storedFile.findMany({
    where: { ...where, status: { not: "uploading" }, deletedAt: null },
    select: SELECT,
    orderBy: { id: "asc" },
    take,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  if (rows.length === 0) return [];
  const folders = await prisma.folder.findMany({ where: { orgId: { in: [...new Set(rows.map((r) => r.orgId))] } }, select: { id: true, parentId: true, name: true } });
  const paths = folderPaths(folders);
  return rows.map((row) => ({ ...row, folderPath: row.folderId ? (paths.get(row.folderId) ?? null) : null }));
}

/** Writes one file's CSV. Nothing is written for a file that is still uploading or deleted. */
export async function writeFactsCsv(prisma: Db, fileId: string): Promise<boolean> {
  const [file] = await load(prisma, { id: fileId }, 1);
  if (!file) return false;
  await putObject(factsKey(file.orgId, file.id), factsCsv(file), "text/csv; charset=utf-8");
  return true;
}

/** The same, but a failure is logged and never fails what the person was doing. */
export async function syncFactsCsv(prisma: Db, fileId: string): Promise<void> {
  try {
    await writeFactsCsv(prisma, fileId);
  } catch (error) {
    console.error(`Facts CSV not written for file ${fileId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Writes the CSV of every file in a company (or everywhere): for existing files, and after the columns change. */
export async function writeAllFactsCsv(prisma: Db, orgId?: string): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  for (;;) {
    const batch = await load(prisma, orgId ? { orgId } : {}, 200, cursor);
    if (batch.length === 0) return count;
    for (const file of batch) await putObject(factsKey(file.orgId, file.id), factsCsv(file), "text/csv; charset=utf-8");
    count += batch.length;
    cursor = batch[batch.length - 1]!.id;
  }
}
