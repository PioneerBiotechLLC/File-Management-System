"use client";

import { Check, ChevronsUpDown, LogOut } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOutAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

type Company = { slug: string; name: string };

export function CompanyHeader({
  company,
  companies,
  user,
  canManage,
  canReview,
  reviewCount,
}: {
  company: Company & { logoUrl: string | null };
  companies: Company[];
  user: { email: string; name: string | null };
  canManage: boolean;
  /** Editors and admins see Review and Deleted. */
  canReview: boolean;
  reviewCount: number;
}) {
  const pathname = usePathname();
  const base = `/c/${company.slug}`;
  const nav: { href: string; label: string; active: boolean; badge?: number }[] = [
    { href: base, label: "Files", active: pathname === base || pathname.startsWith(`${base}/files`) },
  ];
  if (canReview) {
    nav.push({ href: `${base}/review`, label: "Review", active: pathname.startsWith(`${base}/review`), badge: reviewCount });
    nav.push({ href: `${base}/trash`, label: "Deleted", active: pathname.startsWith(`${base}/trash`) });
  }
  if (canManage) {
    nav.push({ href: `${base}/log`, label: "Log", active: pathname.startsWith(`${base}/log`) });
    nav.push({ href: `${base}/settings`, label: "Settings", active: pathname.startsWith(`${base}/settings`) });
  }

  return (
    <header className="border-b">
      <div className="h-1 bg-brand" />
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4">
        {companies.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="px-2 font-semibold">
                <CompanyMark company={company} />
                {company.name}
                <ChevronsUpDown className="text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel className="text-muted-foreground text-xs">Switch company</DropdownMenuLabel>
              {companies.map((c) => (
                <DropdownMenuItem key={c.slug} asChild>
                  <Link href={`/c/${c.slug}`}>
                    <Check className={cn(c.slug === company.slug ? "opacity-100" : "opacity-0")} />
                    {c.name}
                  </Link>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Link href={base} className="flex items-center gap-2 px-2 font-semibold">
            <CompanyMark company={company} />
            {company.name}
          </Link>
        )}

        <nav className="flex gap-1">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm",
                item.active ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
              {item.badge ? (
                <span className="bg-brand ml-1.5 rounded-full px-1.5 py-0.5 text-xs font-medium text-white" aria-label={`${item.badge} waiting`}>
                  {item.badge}
                </span>
              ) : null}
            </Link>
          ))}
        </nav>

        <div className="ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="max-w-56 truncate">
                {user.name ?? user.email}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="text-muted-foreground font-normal">{user.email}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void signOutAction()}>
                <LogOut />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}

function CompanyMark({ company }: { company: Company & { logoUrl: string | null } }) {
  if (company.logoUrl) {
    return <img src={company.logoUrl} alt="" className="size-6 rounded object-contain" />;
  }
  return (
    <span className="bg-brand flex size-6 items-center justify-center rounded text-xs font-bold text-white">
      {company.name.slice(0, 1).toUpperCase()}
    </span>
  );
}
