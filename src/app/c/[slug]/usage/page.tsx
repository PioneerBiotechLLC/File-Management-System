import { notFound } from "next/navigation";
import { usageReport } from "@/lib/ai-limits";
import { db } from "@/lib/db";
import { can } from "@/lib/permissions";
import { companyContext } from "@/lib/session";
import { UsageDashboard } from "./usage-dashboard";

export const metadata = { title: "AI usage" };

export default async function UsagePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { org, role } = await companyContext(slug);
  if (!can(role, "settings.manage")) notFound();

  const report = await usageReport(db(), { id: org.id, timezone: org.timezone });
  const { ANTHROPIC_API_KEY } = process.env;

  return (
    <div className="grid max-w-5xl gap-6">
      <div>
        <h1 className="text-xl font-semibold">AI usage</h1>
        <p className="text-muted-foreground text-sm">
          What the AI has cost {org.name} today and this month, per person, against the limits. When someone reaches a limit, they write the
          summary themselves until it resets (days and months follow {org.timezone}).
        </p>
        {!ANTHROPIC_API_KEY?.trim() && (
          <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            The AI is not set up on this server (no API key), so every summary is written by hand.
          </p>
        )}
      </div>
      <UsageDashboard slug={slug} report={report} />
    </div>
  );
}
