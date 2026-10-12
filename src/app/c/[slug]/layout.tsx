import type { Metadata } from "next";
import { CompanyHeader } from "@/components/company-header";
import { UploadProvider } from "@/components/upload-provider";
import { brandColor, companiesForUser } from "@/lib/companies";
import { db } from "@/lib/db";
import { limitsEnv } from "@/lib/env";
import { fileKindsFor } from "@/lib/file-kinds";
import { countUnfiled, fileContext } from "@/lib/files";
import { can } from "@/lib/permissions";
import { companyContext } from "@/lib/session";

type Props = { params: Promise<{ slug: string }>; children: React.ReactNode };

export async function generateMetadata({ params }: Omit<Props, "children">): Promise<Metadata> {
  const { org } = await companyContext((await params).slug);
  return { title: { default: org.name, template: `%s · ${org.name}` } };
}

/** Resolves the company and role first; no access is a real 404 from here, before any streaming. */
export default async function CompanyLayout({ params, children }: Props) {
  const { slug } = await params;
  const { org, role, user } = await companyContext(slug);
  const companies = await companiesForUser(db(), user);
  const brand = brandColor(org.primaryColor);
  const canReview = can(role, "review.accept");
  const reviewCount = canReview ? await countUnfiled(db(), { orgId: org.id, userId: user.id, role }) : 0;

  // What the upload window offers: the answers to "What is this file?" and the folders this person can file into.
  const canUpload = can(role, "file.upload");
  const ctx = canUpload ? await fileContext(db(), { orgId: org.id, userId: user.id, email: user.email, role }) : null;
  const kinds = ctx ? fileKindsFor(ctx.paths, ctx.writable) : [];
  const uploadFolders = ctx
    ? [...ctx.writable].map((id) => ({ id, path: ctx.paths.get(id) ?? "" })).sort((a, b) => a.path.localeCompare(b.path))
    : [];

  return (
    <div className="flex min-h-dvh flex-col" style={brand ? ({ "--brand": brand } as React.CSSProperties) : undefined}>
      <CompanyHeader
        company={{ slug: org.slug, name: org.name, logoUrl: org.logoUrl }}
        companies={companies.map((c) => ({ slug: c.slug, name: c.name }))}
        user={{ email: user.email, name: user.name ?? null }}
        canManage={can(role, "settings.manage")}
        canReview={canReview}
        reviewCount={reviewCount}
      />
      <UploadProvider slug={org.slug} canUpload={canUpload} maxMb={limitsEnv().FILES_MAX_MB} kinds={kinds} folders={uploadFolders}>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">{children}</main>
      </UploadProvider>
    </div>
  );
}
