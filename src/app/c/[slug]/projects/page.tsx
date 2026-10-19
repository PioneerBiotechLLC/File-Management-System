import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { limitsEnv } from "@/lib/env";
import { fileContext } from "@/lib/files";
import { projectLevels } from "@/lib/projects";
import { companyContext } from "@/lib/session";
import { ProjectUploader } from "./project-uploader";

export const metadata = { title: "Upload project" };

export default async function ProjectUploadPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { org, role, user } = await companyContext(slug);
  if (role !== "admin") notFound();
  const ctx = await fileContext(db(), { orgId: org.id, userId: user.id, email: user.email, role });
  const levels = projectLevels(ctx.folders);
  // Projects and the projects in it, plus one level down, as places to upload into.
  const targets = ctx.folders
    .filter((f) => f.kind === "project" && f.isActive && (levels.get(f.id) ?? 0) <= 2)
    .map((f) => ({ id: f.id, path: ctx.paths.get(f.id) ?? f.name, level: levels.get(f.id) ?? 0 }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const root = targets.find((t) => t.level === 0);

  return (
    <div className="grid max-w-5xl gap-6">
      <div>
        <h1 className="text-xl font-semibold">Upload a project</h1>
        <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
          Choose a folder from your computer. It is uploaded exactly as it is, with the same subfolders, into {root ? root.path : "Projects"} or the folder you
          pick below. The AI does not read these files and never files anything into project folders. Files already in the same folder are skipped, so an
          interrupted upload can simply be started again. Keep this tab open until it finishes.
        </p>
      </div>
      <ProjectUploader slug={slug} maxMb={limitsEnv().FILES_MAX_MB} targets={targets.filter((t) => t.level > 0)} rootPath={root?.path ?? "Projects"} />
    </div>
  );
}
