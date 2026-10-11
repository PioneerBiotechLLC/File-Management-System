/** Runs once when a server starts: reports an incomplete environment clearly instead of failing later. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { environmentProblems } = await import("@/lib/env");
  const problems = environmentProblems();
  if (problems.length > 0) {
    console.error(`[files] The environment is incomplete:\n  - ${problems.join("\n  - ")}\nSee .env.example. /api/health reports the same.`);
  }
}
