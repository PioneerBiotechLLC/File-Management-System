import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { signInWithMicrosoft } from "@/app/actions";

export const metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ callbackUrl?: string }> }) {
  const { callbackUrl } = await searchParams;
  if ((await auth())?.user?.id) redirect("/");

  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/40 p-6">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Files</CardTitle>
          <CardDescription>Your company&apos;s documents, filed and found with AI.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={signInWithMicrosoft}>
            <input type="hidden" name="callbackUrl" value={callbackUrl ?? "/"} />
            <Button type="submit" className="w-full">
              <svg viewBox="0 0 21 21" aria-hidden="true">
                <path fill="#f25022" d="M1 1h9v9H1z" />
                <path fill="#7fba00" d="M11 1h9v9h-9z" />
                <path fill="#00a4ef" d="M1 11h9v9H1z" />
                <path fill="#ffb900" d="M11 11h9v9h-9z" />
              </svg>
              Sign in with Microsoft
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
