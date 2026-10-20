import { z } from "zod";
import { autoFileAfterRead, type BulkOutcome } from "@/lib/bulk";
import { slugSchema } from "@/lib/companies";
import type { Db } from "@/lib/db";
import { UserError } from "@/lib/errors";
import { confirmUpload, fileContext, startUpload, type FileContext } from "@/lib/files";
import { readUpload, type ReadOutcome } from "@/lib/intake";

/**
 * Email attachments sent in by the Email Tracker (its `pnpm attachments` job and 15-minute cron).
 * The tracker goes through the same three steps as a browser upload: start (metadata), PUT the
 * bytes to the presigned URL, confirm. Every file is then read by the AI and, like a bulk upload,
 * filed at once when the AI is sure enough, or left in Review for a person.
 *
 * Each company has one system user for this, `email-tracker@<domain>`: deactivated (it can never
 * sign in), an editor (its AI reads count against the usual per-person and company spend caps),
 * shown in Settings → Users and in the Log like anyone else.
 */

export const SYSTEM_USER_NAME = "Email Tracker";

export const emailAttachmentInput = z.object({
  company: slugSchema,
  file: z.object({
    name: z.string().min(1).max(1_000),
    mimeType: z.string().max(300),
    size: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  email: z.object({
    /** Message-ID header (or the Graph id); kept as the file's sourceRef */
    messageId: z.string().min(1).max(500),
    subject: z.string().max(1_000),
    from: z.string().max(320),
    to: z.array(z.string().max(320)).max(100),
    direction: z.enum(["inbound", "outbound"]),
    /** ISO instant the email was sent or received */
    at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO date"),
    mailbox: z.string().max(320),
    trackerUrl: z.string().url().max(1_000).nullable(),
  }),
});
export type EmailAttachmentInput = z.input<typeof emailAttachmentInput>;

export const confirmInput = z.object({ company: slugSchema, versionNo: z.number().int().positive() });

export type StartResult =
  | { kind: "upload"; fileId: string; versionNo: number; uploadUrl: string; contentType: string }
  | { kind: "duplicate"; fileId: string; name: string; folderPath: string | null };

export class UnknownCompanyError extends UserError {
  constructor(slug: string) {
    super(`No company "${slug}".`);
    this.name = "UnknownCompanyError";
  }
}

type Company = { id: string; slug: string; name: string; domain: string; timezone: string };

async function companyBySlug(prisma: Db, slug: string): Promise<Company> {
  const org = await prisma.organization.findUnique({ where: { slug }, select: { id: true, slug: true, name: true, domain: true, timezone: true } });
  if (!org) throw new UnknownCompanyError(slug);
  return org;
}

export const systemUserEmail = (domain: string) => `email-tracker@${domain}`;

/** The company's system user and its editor membership, created on first use. */
export async function systemUser(prisma: Db, org: Pick<Company, "id" | "domain">): Promise<{ id: string; email: string }> {
  const email = systemUserEmail(org.domain);
  const user = await prisma.appUser.upsert({
    where: { email },
    create: { email, name: SYSTEM_USER_NAME, isActive: false },
    // Never let it sign in, whatever an admin did to the row in between.
    update: { isActive: false },
    select: { id: true, email: true },
  });
  await prisma.membership.upsert({
    where: { userId_orgId: { userId: user.id, orgId: org.id } },
    create: { userId: user.id, orgId: org.id, role: "editor" },
    update: {},
  });
  return user;
}

/** Folder access as an admin (so the AI may file anywhere), the usage and the log under the system user. */
async function systemContext(prisma: Db, org: Pick<Company, "id" | "domain">): Promise<FileContext> {
  const user = await systemUser(prisma, org);
  return fileContext(prisma, { orgId: org.id, userId: user.id, email: user.email, role: "admin" });
}

/**
 * Step 1: records the file and returns where to PUT the bytes. An identical file already in the
 * company is reported instead (the tracker then links the email to it).
 */
export async function startEmailAttachment(prisma: Db, rawInput: EmailAttachmentInput): Promise<StartResult> {
  const input = emailAttachmentInput.parse(rawInput);
  const org = await companyBySlug(prisma, input.company);
  const ctx = await systemContext(prisma, org);
  const started = await startUpload(prisma, ctx, { ...input.file, folderId: null, allowDuplicate: false });
  if (started.kind === "duplicate") return { kind: "duplicate", fileId: started.existing.id, name: started.existing.name, folderPath: started.existing.folderPath };

  const { email } = input;
  await prisma.$transaction([
    prisma.storedFile.update({ where: { id: started.fileId }, data: { source: "email_attachment", sourceRef: `email:${email.messageId}` } }),
    prisma.auditLog.create({
      data: {
        orgId: org.id,
        userEmail: ctx.email,
        action: "file.email_attachment",
        targetType: "file",
        targetId: started.fileId,
        after: { name: started.name, subject: email.subject, from: email.from, to: email.to, direction: email.direction, at: email.at, mailbox: email.mailbox, messageId: email.messageId, trackerUrl: email.trackerUrl },
      },
    }),
  ]);
  return { kind: "upload", fileId: started.fileId, versionNo: started.versionNo, uploadUrl: started.uploadUrl, contentType: started.contentType };
}

/** Step 3: the bytes are in the bucket; the file becomes real and goes to the AI. Confirming twice is harmless. */
export async function confirmEmailAttachment(prisma: Db, input: { company: string; fileId: string; versionNo: number }): Promise<{ status: "processing" | "ready" | "needs_review"; org: Company }> {
  const parsed = confirmInput.parse({ company: input.company, versionNo: input.versionNo });
  const org = await companyBySlug(prisma, parsed.company);
  const ctx = await systemContext(prisma, org);
  const file = await prisma.storedFile.findFirst({ where: { id: input.fileId, orgId: org.id, source: "email_attachment" }, select: { id: true } });
  if (!file) throw new UserError("That upload was not found. Please try again.");
  const r = await confirmUpload(prisma, ctx, { fileId: file.id, versionNo: parsed.versionNo });
  return { status: r.status, org };
}

/** How long the read waits while another of the system user's reads is running (one at a time per person). */
const BUSY_RETRY_MS = 5_000;
const BUSY_RETRIES = 12;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ProcessOutcome = { read: ReadOutcome; filing: BulkOutcome | null };

/**
 * After confirm, in the background: the AI reads the file, then it is filed the way bulk uploads
 * are (sure enough → its folder, else General; unreadable → deleted). Never throws: whatever fails leaves the file in Review.
 */
export async function processEmailAttachment(prisma: Db, org: Company, fileId: string): Promise<ProcessOutcome> {
  const ctx = await systemContext(prisma, org);
  let read: ReadOutcome = { status: "busy" };
  for (let attempt = 0; attempt < BUSY_RETRIES; attempt++) {
    read = await readUpload(prisma, ctx, org, fileId);
    if (read.status !== "busy") break;
    await sleep(BUSY_RETRY_MS);
  }
  // A file the AI cannot read goes on too, to be deleted; one whose read failed waits in Review.
  if (read.status === "busy" || (read.status === "not_read" && read.retryable)) return { read, filing: null };
  try {
    return { read, filing: await autoFileAfterRead(prisma, ctx, org, fileId) };
  } catch (error) {
    console.error(`email attachment ${fileId}: filing failed: ${error instanceof Error ? error.message : String(error)}`);
    return { read, filing: null };
  }
}
