import type { Metadata } from "next";
import { CompanyHeader } from "@/components/company-header";
import { brandColor, companiesForUser } from "@/lib/companies";
import { db } from "@/lib/db";
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

  return (
    <div className="flex min-h-dvh flex-col" style={brand ? ({ "--brand": brand } as React.CSSProperties) : undefined}>
      <CompanyHeader
        company={{ slug: org.slug, name: org.name, logoUrl: org.logoUrl }}
        companies={companies.map((c) => ({ slug: c.slug, name: c.name }))}
        user={{ email: user.email, name: user.name ?? null }}
        canManage={can(role, "settings.manage")}
      />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
