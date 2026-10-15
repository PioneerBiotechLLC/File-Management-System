import { execSync } from "node:child_process";

/**
 * The production build. On Vercel the database migrations are applied first, so a deploy never
 * runs code against a schema that is behind it. Locally (no VERCEL) the build leaves the database
 * alone; run `pnpm db:deploy` or `pnpm db:migrate` yourself.
 */
const run = (cmd) => execSync(cmd, { stdio: "inherit" });

if (process.env.VERCEL === "1") run("prisma migrate deploy");
run("prisma generate");
run("next build");
