import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };

export default defineConfig({
  resolve: { alias },
  test: {
    environment: "node",
    projects: [
      { resolve: { alias }, test: { name: "unit", include: ["src/**/*.test.ts"], exclude: ["src/**/*.db.test.ts"] } },
      // Database-backed tests share one Postgres (TEST_DATABASE_URL), so their files run one at a time.
      { resolve: { alias }, test: { name: "db", include: ["src/**/*.db.test.ts"], fileParallelism: false } },
    ],
  },
});
