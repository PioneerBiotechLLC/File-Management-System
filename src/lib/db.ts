import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import { databaseEnv } from "@/lib/env";

export type Db = PrismaClient;
/** The client or an open transaction, for functions that must run inside a caller's transaction. */
export type DbTx = Prisma.TransactionClient;

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/** The process-wide Prisma client, created on first use so builds never need a database. */
export function db(): PrismaClient {
  if (!globalForPrisma.prisma) {
    const adapter = new PrismaPg({ connectionString: databaseEnv().DATABASE_URL });
    globalForPrisma.prisma = new PrismaClient({ adapter });
  }
  return globalForPrisma.prisma;
}

/** Closes the connection pool if one was opened; for command-line jobs. */
export async function disconnect(): Promise<void> {
  await globalForPrisma.prisma?.$disconnect();
}
