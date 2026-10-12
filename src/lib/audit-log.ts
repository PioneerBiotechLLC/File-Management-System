import type { Db } from "@/lib/db";
import { DOC_TYPE_LABELS, type DocType } from "@/lib/doc-types";
import type { Prisma } from "@/generated/prisma/client";

// ---------------------------------------------------------------------------------------------
// Sign-in events
// ---------------------------------------------------------------------------------------------

/**
 * The companies a sign-in event belongs to: the person's memberships, or else the company whose
 * domain matches their email (so a refused colleague shows up in that company's log).
 * Null when neither applies, such as an owner from another domain.
 */
async function companiesFor(prisma: Db, email: string, userId: string | null): Promise<(string | null)[]> {
  if (userId) {
    const memberships = await prisma.membership.findMany({ where: { userId }, select: { orgId: true } });
    if (memberships.length > 0) return memberships.map((m) => m.orgId);
  }
  const domain = email.split("@")[1];
  const org = domain ? await prisma.organization.findUnique({ where: { domain }, select: { id: true } }) : null;
  return [org?.id ?? null];
}

/** Records a sign-in or sign-out once in each company the person belongs to. */
export async function recordSession(prisma: Db, action: "auth.signin" | "auth.signout", user: { id: string; email: string }): Promise<void> {
  const orgIds = await companiesFor(prisma, user.email, user.id);
  await prisma.auditLog.createMany({
    data: orgIds.map((orgId) => ({ orgId, userEmail: user.email, action, targetType: "user", targetId: user.id })),
  });
}

/** Records a refused sign-in: someone not on the list, or deactivated. */
export async function recordRefusedSignIn(prisma: Db, email: string, reason: "not_listed" | "inactive"): Promise<void> {
  const user = await prisma.appUser.findUnique({ where: { email }, select: { id: true } });
  const orgIds = await companiesFor(prisma, email, user?.id ?? null);
  await prisma.auditLog.createMany({
    data: orgIds.map((orgId) => ({ orgId, userEmail: email, action: "auth.refused", targetType: "user", targetId: user?.id ?? email, after: { reason } })),
  });
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

export const LOG_CATEGORIES = {
  signins: { label: "Sign-ins", prefixes: ["auth."] },
  files: { label: "Files", prefixes: ["file."] },
  folders: { label: "Folders", prefixes: ["folder."] },
  people: { label: "People", prefixes: ["user.", "membership."] },
  searches: { label: "Searches", prefixes: ["search."] },
  company: { label: "Company and AI", prefixes: ["org.", "ai."] },
} as const;

export type LogCategory = keyof typeof LOG_CATEGORIES;

const LOG_PAGE_SIZE = 100;

/**
 * One company's log, newest first. Owners also see entries tied to no company, such as making
 * someone an owner, since those are only ever made by owners.
 */
export async function listAuditLog(
  prisma: Db,
  input: { orgId: string; includeUnscoped: boolean; email?: string; category?: LogCategory; page?: number },
) {
  const scope: Prisma.AuditLogWhereInput = input.includeUnscoped ? { OR: [{ orgId: input.orgId }, { orgId: null }] } : { orgId: input.orgId };
  const where: Prisma.AuditLogWhereInput = {
    AND: [
      scope,
      input.email ? { userEmail: input.email } : {},
      input.category ? { OR: LOG_CATEGORIES[input.category].prefixes.map((p) => ({ action: { startsWith: p } })) } : {},
    ],
  };
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const [items, total, people] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * LOG_PAGE_SIZE, take: LOG_PAGE_SIZE }),
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({ where: scope, distinct: ["userEmail"], select: { userEmail: true }, orderBy: { userEmail: "asc" } }),
  ]);

  // Names for the files the entries point at, including deleted ones.
  const fileIds = [...new Set(items.filter((i) => i.targetType === "file").map((i) => i.targetId))];
  const userIds = [...new Set(items.filter((i) => i.targetType === "user").map((i) => i.targetId))];
  const [files, users] = await Promise.all([
    fileIds.length
      ? prisma.storedFile.findMany({ where: { orgId: input.orgId, id: { in: fileIds } }, select: { id: true, name: true, deletedAt: true } })
      : [],
    userIds.length ? prisma.appUser.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } }) : [],
  ]);

  return {
    items,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / LOG_PAGE_SIZE)),
    people: people.map((p) => p.userEmail),
    files: new Map(files.map((f) => [f.id, { name: f.name, deleted: f.deletedAt !== null }])),
    users: new Map(users.map((u) => [u.id, u.email])),
  };
}

// ---------------------------------------------------------------------------------------------
// Describing
// ---------------------------------------------------------------------------------------------

export type LogPart = string | { file: string; name: string; link: boolean } | { folder: string };

type Entry = { action: string; targetType: string; targetId: string; before: unknown; after: unknown };

type Lookups = {
  files: Map<string, { name: string; deleted: boolean }>;
  /** "Sales / Quotations" by folder id. */
  folders: Map<string, string>;
  /** Email by user id, for entries that did not record one. */
  users: Map<string, string>;
};

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

const DETAIL_LABELS: Record<string, string> = { title: "title", summary: "summary", docType: "type", docDate: "date", tags: "tags" };
const money = (value: unknown) => (typeof value === "number" ? `$${value.toFixed(value < 0.1 ? 3 : 2)}` : null);
const cap = (value: unknown) => (typeof value === "number" ? `$${value.toFixed(2)}` : "the default");
const REFUSED: Record<string, string> = { not_listed: "not on the list of users", inactive: "account deactivated" };

/** A plain-English sentence for one log entry, as text and links. */
export function describeEntry(entry: Entry, lookups: Lookups): LogPart[] {
  const before = record(entry.before);
  const after = record(entry.after);
  const known = lookups.files.get(entry.targetId);
  const file: LogPart = {
    file: entry.targetId,
    name: known?.name ?? text(after.name) ?? text(before.name) ?? "a file that has since been removed",
    link: known !== undefined && !known.deleted,
  };
  const folder = (id: unknown): LogPart => (typeof id === "string" && lookups.folders.has(id) ? { folder: lookups.folders.get(id)! } : "Review");
  const target = folder(entry.targetId);
  const person = text(after.email) ?? text(before.email) ?? text(after.user) ?? text(before.user) ?? lookups.users.get(entry.targetId) ?? "someone";

  switch (entry.action) {
    case "auth.signin":
      return ["Signed in"];
    case "auth.signout":
      return ["Signed out"];
    case "auth.refused":
      return [`Was refused sign-in (${REFUSED[text(after.reason) ?? ""] ?? "not allowed"})`];

    case "file.upload":
      return ["Uploaded ", file, after.folderId ? " to " : " (waiting in ", folder(after.folderId), after.folderId ? "" : ")"];
    case "file.version":
      return [`Uploaded version ${String(after.versionNo ?? "")} of `, file];
    case "file.move":
      return ["Moved ", file, " from ", folder(before.folderId), " to ", folder(after.folderId)];
    case "file.rename":
      return [`Renamed “${text(before.name) ?? ""}” to `, file];
    case "file.details": {
      const changed = Object.keys(DETAIL_LABELS).filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null));
      return ["Edited ", changed.length ? `the ${changed.map((k) => DETAIL_LABELS[k]).join(", ")} of ` : "the details of ", file];
    }
    case "file.delete":
      return ["Deleted ", file];
    case "file.restore":
      return ["Restored ", file];
    case "file.download":
    case "file.preview": {
      const verb = entry.action === "file.download" ? "Downloaded " : "Viewed ";
      return after.current === false ? [verb, `version ${String(after.versionNo)} of `, file] : [verb, file];
    }
    case "file.analyze": {
      const cost = money(after.costUsd);
      if (after.outcome === "read") return ["Had the AI read ", file, cost ? ` (${cost})` : ""];
      if (after.outcome === "failed") return ["AI reading of ", file, ` failed: ${text(after.reason) ?? "unknown error"}`];
      return ["The AI did not read ", file, `: ${text(after.reason) ?? "no reason given"}`];
    }
    case "file.summary":
      if (after.source !== "ai") return ["Wrote the summary of ", file];
      return [after.edited ? "Edited and confirmed the AI summary of " : "Confirmed the AI summary of ", file];
    case "ai.limits": {
      const who = entry.targetType === "organization" ? "the company's" : `${person}'s`;
      return [`Set ${who} AI limits to ${cap(after.dailyUsd)} a day and ${cap(after.monthlyUsd)} a month`];
    }
    case "search.instant": {
      const filters = record(after.filters);
      const where = [
        typeof filters.folderId === "string" && lookups.folders.has(filters.folderId) ? `in ${lookups.folders.get(filters.folderId)}` : null,
        text(filters.docType) ? `type ${DOC_TYPE_LABELS[filters.docType as DocType] ?? text(filters.docType)}` : null,
        text(filters.dateFrom) ? `from ${text(filters.dateFrom)}` : null,
        text(filters.dateTo) ? `to ${text(filters.dateTo)}` : null,
      ].filter(Boolean);
      return [`Searched for “${text(after.query) ?? ""}”${where.length ? ` ${where.join(", ")}` : ""} (${String(after.hits ?? 0)} ${after.hits === 1 ? "result" : "results"})`];
    }
    case "search.ask": {
      const found = Array.isArray(after.files) ? after.files.length : 0;
      const outcome = text(after.error) ? `failed: ${text(after.error)}` : `${found} ${found === 1 ? "file" : "files"} found`;
      return [`Asked the AI “${text(after.question) ?? ""}” (${outcome})`];
    }

    case "folder.create":
      return ["Created the folder ", target];
    case "folder.update":
      return [text(before.name) && before.name !== after.name ? `Renamed the folder “${text(before.name)}” to ` : "Changed the folder ", target];
    case "folder.activate":
      return ["Reactivated the folder ", target];
    case "folder.deactivate":
      return ["Deactivated the folder ", target];
    case "folder.grant":
      return [`Gave ${person} ${after.canWrite ? "read and write" : "read-only"} access to `, target];
    case "folder.revoke":
      return [`Removed ${person}'s access to `, target];

    case "org.create":
      return ["Created the company"];
    case "user.create":
      return [`Created an account for ${person}`];
    case "membership.add":
      return [`Added ${person} as ${text(after.role) ?? "a member"}`];
    case "membership.role":
      return [`Changed ${person} from ${text(before.role) ?? "?"} to ${text(after.role) ?? "?"}`];
    case "membership.remove":
      return [`Removed ${person} from the company`];
    case "user.owner":
      return [`Made ${person} an owner`];
    case "user.deactivate":
      return [`Deactivated ${person}`];
    case "user.reactivate":
      return [`Reactivated ${person}`];
    default:
      return [entry.action];
  }
}
