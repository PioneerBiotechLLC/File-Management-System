import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { companiesForUser } from "@/lib/companies";
import { LAST_COMPANY_COOKIE } from "@/lib/cookies";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";

/** Opens the last company the user visited, or their only one; otherwise lets them pick. */
export default async function Home() {
  const user = await currentUser();
  const companies = await companiesForUser(db(), user);
  if (companies.length === 0) redirect("/no-access?reason=no_company");

  const last = (await cookies()).get(LAST_COMPANY_COOKIE)?.value;
  const target = companies.length === 1 ? companies[0] : companies.find((c) => c.slug === last);
  if (target) redirect(`/c/${target.slug}`);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/40 p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Choose a company</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2">
          {companies.map((c) => (
            <Link key={c.id} href={`/c/${c.slug}`} className="hover:bg-accent rounded-md border px-4 py-3">
              <div className="font-medium">{c.name}</div>
              <div className="text-muted-foreground text-xs capitalize">{c.role}</div>
            </Link>
          ))}
        </CardContent>
      </Card>
    </main>
  );
}
