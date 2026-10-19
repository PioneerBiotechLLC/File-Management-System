import { notFound } from "next/navigation";
import { limitsEnv } from "@/lib/env";
import { companyContext } from "@/lib/session";
import { BulkUploader } from "./bulk-uploader";

export const metadata = { title: "Bulk upload" };

export default async function BulkUploadPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { role } = await companyContext(slug);
  if (role !== "admin") notFound();
  const { ANTHROPIC_API_KEY } = process.env;

  return (
    <div className="grid max-w-5xl gap-6">
      <div>
        <h1 className="text-xl font-semibold">Bulk upload</h1>
        <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
          Choose a folder or a set of files; zips are opened. Each file is uploaded, read by the AI and filed straight away, with no confirmation. Files the AI
          could not read, was less than 60% sure about, or that are over {limitsEnv().FILES_AI_MAX_MB} MB are left in Review. Files that have no place in the
          tree go to General, marked unsure. Keep this tab open until the report appears.
        </p>
      </div>
      <BulkUploader slug={slug} maxMb={limitsEnv().FILES_MAX_MB} aiMaxMb={limitsEnv().FILES_AI_MAX_MB} aiAvailable={Boolean(ANTHROPIC_API_KEY?.trim())} />
    </div>
  );
}
