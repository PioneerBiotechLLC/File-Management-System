import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { signOutAction } from "@/app/actions";

export const metadata = { title: "No access" };

const REASONS: Record<string, { title: string; body: React.ReactNode }> = {
  not_listed: {
    title: "You're not on the list",
    body: "Your Microsoft account signed in, but it has not been added to Files. Ask an admin to add your work email.",
  },
  inactive: {
    title: "Your access was removed",
    body: "Your account has been deactivated. Ask an owner if you think this is a mistake.",
  },
  no_company: {
    title: "No company yet",
    body: "You can sign in, but you are not a member of any company. Ask an admin to add you to one.",
  },
  no_email: {
    title: "No email on your account",
    body: "Microsoft did not share an email address for your account, so Files cannot tell who you are. Ask IT to check your account.",
  },
  tenant: {
    title: "Wrong Microsoft organisation",
    body: "Your Microsoft account belongs to an organisation that does not use Files. Sign in with your work account.",
  },
  no_tenant: {
    title: "Account not recognised",
    body: "Microsoft did not say which organisation your account belongs to, so Files cannot let you in. Ask IT to check your account.",
  },
  account_mismatch: {
    title: "A different account uses this email",
    body: "Your email is on the list, but it was first used from another Microsoft account. If you have a new account, ask an owner to re-link you.",
  },
  error: {
    title: "Something went wrong on our side",
    body: (
      <>
        Files could not check your access. Try again in a minute. If it keeps happening, an admin can open{" "}
        <a className="underline" href="/api/health">
          /api/health
        </a>{" "}
        to see what is down.
      </>
    ),
  },
};

export default async function NoAccessPage({ searchParams }: { searchParams: Promise<{ reason?: string; error?: string }> }) {
  const { reason, error } = await searchParams;
  // Auth.js sends `error=…` for its own failures; AccessDenied means our sign-in check said no.
  const key = reason ?? (error === "AccessDenied" ? "not_listed" : "error");
  const content = REASONS[key] ?? REASONS.error!;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/40 p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{content.title}</CardTitle>
          <CardDescription className="leading-relaxed">{content.body}</CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Button asChild variant="outline">
            <Link href="/signin">Try again</Link>
          </Button>
          <form action={signOutAction}>
            <Button type="submit" variant="ghost">
              Sign out
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
