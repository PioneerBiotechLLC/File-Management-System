import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { PrismaClient } from "@/generated/prisma/client";

/** Database-backed tests run only when TEST_DATABASE_URL points at a disposable Postgres. */
export const { TEST_DATABASE_URL } = process.env;

const MIGRATIONS = join(process.cwd(), "prisma", "migrations");

/** The migration folders in the order Prisma applies them. */
export function migrationNames(): string[] {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/**
 * A new, empty schema with every committed migration applied in order, so test files can run in
 * parallel against one database without touching each other's data.
 */
export async function freshDatabase(): Promise<{ prisma: PrismaClient; schema: string; drop: () => Promise<void> }> {
  if (!TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is not set");
  const schema = `test_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const admin = new Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.query(`SET search_path TO "${schema}"`);
  for (const name of migrationNames()) {
    await admin.query(readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8"));
  }
  // Prisma's local dev server shares session settings between connections, so never leave this set.
  await admin.query("SET search_path TO public");
  // One connection: Prisma's local dev server (PGlite) breaks when connections interleave.
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL, max: 1 }, { schema }) });
  return {
    prisma,
    schema,
    drop: async () => {
      await prisma.$disconnect();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    },
  };
}
