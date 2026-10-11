import { defineConfig } from "prisma/config";

try {
  process.loadEnvFile();
} catch {
  // No .env file: the variables come from the shell or the host.
}

const { DIRECT_URL, DATABASE_URL } = process.env;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Migrations need a direct (unpooled) connection; fall back to DATABASE_URL locally.
  datasource: { url: DIRECT_URL || DATABASE_URL },
});
