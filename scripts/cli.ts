import { userInfo } from "node:os";
import { Command, Option } from "commander";
import { z } from "zod";
import { createCompany, slugSchema } from "@/lib/companies";
import { db, disconnect } from "@/lib/db";
import { seedDefaultFolders } from "@/lib/folders";
import { UserError } from "@/lib/errors";
import { reindexAll } from "@/lib/search-index";
import { addMember, deactivateUser, emailSchema, makeOwner, removeMember } from "@/lib/users";

try {
  process.loadEnvFile();
} catch {
  // No .env file: the variables come from the shell.
}

/** Audit entries made from the command line name the laptop user. */
const actor = { email: `cli:${userInfo().username}` };

async function companyBySlug(slug: string) {
  const org = await db().organization.findUnique({ where: { slug: slugSchema.parse(slug) }, select: { id: true, slug: true, name: true } });
  if (!org) throw new UserError(`No company with slug "${slug}". Create it with: pnpm org add ${slug} --name ... --domain ...`);
  return org;
}

const program = new Command()
  .name("files")
  .description("Files administration. Uses DATABASE_URL from .env or the shell.")
  .showHelpAfterError();

const org = program.command("org").description("Companies");

org
  .command("add <slug>")
  .description("Create a company and its default folder tree")
  .requiredOption("--name <name>", 'display name, e.g. "API Pharma"')
  .requiredOption("--domain <domain>", "primary email domain, e.g. api-pharma.net")
  .action(async (slug: string, opts: { name: string; domain: string }) => {
    const created = await createCompany(db(), { slug, name: opts.name, domain: opts.domain, actorEmail: actor.email });
    console.log(`Created ${created.slug} with ${created.foldersCreated} folders.`);
  });

const user = program.command("user").description("Users and their companies");

user
  .command("add <email>")
  .description("Add a user to a company with a role, or make them an owner (admin in every company)")
  .option("--org <slug>", "company slug")
  .addOption(new Option("--role <role>", "role in the company").choices(["admin", "editor", "viewer"]))
  .option("--owner", "make the user an owner")
  .action(async (email: string, opts: { org?: string; role?: "admin" | "editor" | "viewer"; owner?: boolean }) => {
    if (!opts.owner && !opts.org) throw new UserError("Give --org <slug> --role <role>, or --owner.");
    if (opts.org && !opts.role) throw new UserError("--org needs --role admin|editor|viewer.");
    if (opts.owner) {
      await makeOwner(db(), { email, actor });
      console.log(`${emailSchema.parse(email)} is an owner (admin in every company).`);
    }
    if (opts.org && opts.role) {
      const company = await companyBySlug(opts.org);
      const { change, reactivated } = await addMember(db(), { orgId: company.id, email, role: opts.role, actor, reactivate: true });
      console.log(`${emailSchema.parse(email)} in ${company.slug}: ${opts.role} (${change.replace("_", " ")}${reactivated ? ", reactivated" : ""}).`);
    }
  });

user
  .command("list")
  .description("List every user with their companies")
  .action(async () => {
    const users = await db().appUser.findMany({
      select: { email: true, name: true, isOwner: true, isActive: true, lastLoginAt: true, memberships: { select: { role: true, org: { select: { slug: true } } } } },
      orderBy: { email: "asc" },
    });
    if (users.length === 0) return console.log("No users yet. Add one with: pnpm user add <email> --owner");
    for (const u of users) {
      const flags = [u.isOwner && "owner", !u.isActive && "DEACTIVATED"].filter(Boolean).join(", ");
      const companies = u.memberships.map((m) => `${m.org.slug}:${m.role}`).join(" ") || "-";
      const login = u.lastLoginAt ? u.lastLoginAt.toISOString().slice(0, 16).replace("T", " ") : "never";
      console.log(`${u.email}${u.name ? ` (${u.name})` : ""}${flags ? ` [${flags}]` : ""}\n  companies: ${companies}\n  last sign-in: ${login}`);
    }
  });

user
  .command("remove <email>")
  .description("Remove a user from one company, or deactivate them everywhere (the row is kept)")
  .option("--org <slug>", "only remove them from this company")
  .action(async (email: string, opts: { org?: string }) => {
    const normalized = emailSchema.parse(email);
    if (opts.org) {
      const company = await companyBySlug(opts.org);
      const target = await db().appUser.findUnique({ where: { email: normalized }, select: { id: true } });
      if (!target) throw new UserError(`${normalized} is not a user.`);
      await removeMember(db(), { orgId: company.id, userId: target.id, actor });
      console.log(`Removed ${normalized} from ${company.slug}.`);
    } else {
      await deactivateUser(db(), { email: normalized, actor });
      console.log(`Deactivated ${normalized}. They are signed out within 5 minutes.`);
    }
  });

const index = program.command("index").description("The search index");

index
  .command("rebuild")
  .description("Rebuild the search entries of every file (one company, or all)")
  .option("--org <slug>", "company slug")
  .action(async (opts: { org?: string }) => {
    const company = opts.org ? await companyBySlug(opts.org) : null;
    const count = await reindexAll(db(), company?.id);
    console.log(`Reindexed ${count} files${company ? ` in ${company.slug}` : ""}.`);
  });

const folders = program.command("folders").description("Folders");

folders
  .command("seed")
  .description("Create any missing default folders (safe to run again)")
  .option("--org <slug>", "only this company (default: every company)")
  .action(async (opts: { org?: string }) => {
    const companies = opts.org
      ? [await companyBySlug(opts.org)]
      : await db().organization.findMany({ select: { id: true, slug: true, name: true }, orderBy: { slug: "asc" } });
    for (const company of companies) {
      const created = await seedDefaultFolders(db(), company.id, "system");
      console.log(`${company.slug}: ${created} folder${created === 1 ? "" : "s"} created.`);
    }
  });

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof UserError) console.error(error.message);
  else if (error instanceof z.ZodError) console.error(z.prettifyError(error));
  else console.error(error);
  process.exitCode = 1;
} finally {
  await disconnect();
}
