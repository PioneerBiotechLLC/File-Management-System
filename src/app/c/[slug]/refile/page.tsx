import { notFound } from "next/navigation";
import { companyContext } from "@/lib/session";
import { Refiler } from "./refiler";

export const metadata = { title: "Re-file" };

export default async function RefilePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { role } = await companyContext(slug);
  if (role !== "admin") notFound();
  const aiAvailable = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  return (
    <div className="grid max-w-5xl gap-6">
      <div>
        <h1 className="text-xl font-semibold">Re-file</h1>
        <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
          Files already in the system are read again by the AI with the current filing rules and moved when it is sure they belong elsewhere. Nothing is uploaded
          again, and every move is in the Log. Start with “Preview only” to see what would move. Keep this tab open until the report appears.
        </p>
      </div>
      <Refiler slug={slug} aiAvailable={aiAvailable} />
    </div>
  );
}
