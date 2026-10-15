"use client";

import { Check, ChevronsUpDown, LogOut, Search } from "lucide-react";
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
    nav.push({ href: `${base}/bulk`, label: "Bulk upload", active: pathname.startsWith(`${base}/bulk`) });
    nav.push({ href: `${base}/refile`, label: "Re-file", active: pathname.startsWith(`${base}/refile`) });
    nav.push({ href: `${base}/log`, label: "Log", active: pathname.startsWith(`${base}/log`) });
    nav.push({ href: `${base}/usage`, label: "Usage", active: pathname.startsWith(`${base}/usage`) });
    nav.push({ href: `${base}/settings`, label: "Settings", active: pathname.startsWith(`${base}/settings`) });
  }

  // The Files page and the search page have the big search box.
  const showSearch = pathname !== base && !pathname.startsWith(`${base}/search`);

  return (
    <header className="border-b">
      <div className="h-1 bg-brand" />
      <div className="mx-auto flex max-w-[120rem] flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 sm:h-14 sm:flex-nowrap sm:px-6 sm:py-0">
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

        <nav className="order-last -mx-4 flex w-[calc(100%+2rem)] gap-1 overflow-x-auto px-4 pb-1 sm:order-none sm:mx-0 sm:w-auto sm:overflow-visible sm:px-0 sm:pb-0">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "shrink-0 rounded-md px-3 py-1.5 text-sm",
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

        <form action={`${base}/search`} className={cn("relative ml-auto hidden", showSearch && "sm:block")}>
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <input
            type="search"
            name="q"
            placeholder="Search files"
            aria-label="Search files"
            className="border-input focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-48 rounded-md border bg-transparent pl-8 pr-2 text-sm outline-none focus-visible:ring-[3px] md:w-64"
          />
        </form>

        <div className="ml-auto flex items-center gap-1 sm:ml-0">
          {showSearch && (
            <Button asChild variant="ghost" size="icon" className="sm:hidden">
              <Link href={`${base}/search`} aria-label="Search files">
                <Search />
              </Link>
            </Button>
          )}
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
    return <img src={company.logoUrl} alt="" className="size-8 object-contain" />;
  }
  return (
    <span className="bg-brand flex size-6 items-center justify-center rounded text-xs font-bold text-white">
      {company.name.slice(0, 1).toUpperCase()}
    </span>
  );
}
