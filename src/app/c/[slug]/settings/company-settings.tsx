"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { resetFilesAction, setBrandAction, type ActionState } from "./actions";

function Message({ state }: { state: ActionState }) {
  if (!state) return null;
  return (
    <p role="status" className={state.error ? "text-destructive text-sm" : "text-muted-foreground text-sm"}>
      {state.error ?? state.ok}
    </p>
  );
}

/** Owners only: the company's look, and the one destructive action. */
export function CompanySettings({ slug, name, logoUrl, primaryColor }: { slug: string; name: string; logoUrl: string | null; primaryColor: string | null }) {
  const [brand, brandAction, brandPending] = useActionState(setBrandAction.bind(null, slug), null);
  const [reset, resetAction, resetPending] = useActionState(resetFilesAction.bind(null, slug), null);
  const [confirm, setConfirm] = useState("");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Company</CardTitle>
        <CardDescription>How {name} appears in the header, and a reset for starting over.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-8">
        <form action={brandAction} className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
            <div className="grid gap-1.5">
              <Label htmlFor="logoUrl">Logo</Label>
              <Input id="logoUrl" name="logoUrl" defaultValue={logoUrl ?? ""} placeholder="/brand/api-pharma-mark.png or https://…" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="primaryColor">Colour</Label>
              <Input id="primaryColor" name="primaryColor" defaultValue={primaryColor ?? ""} placeholder="#be272c" />
            </div>
          </div>
          <p className="text-muted-foreground text-xs">The logo is an https:// address or a file on this site; the colour is a hex value. Leave empty to use the default.</p>
          <div className="flex items-center gap-3">
            <Button type="submit" variant="outline" disabled={brandPending}>
              Save
            </Button>
            <Message state={brand} />
          </div>
        </form>

        <form action={resetAction} className="border-destructive/40 grid gap-3 rounded-lg border p-4">
          <div>
            <h3 className="text-destructive font-medium">Remove all files</h3>
            <p className="text-muted-foreground mt-1 text-sm">
              Deletes every file, including versions and anything in Review or Deleted, with its stored bytes; every customer and supplier; and all
              the year, customer and supplier folders. The company&apos;s own folders, people, the log and the AI spend stay. This cannot be undone.
            </p>
          </div>
          <div className="grid gap-1.5 sm:max-w-xs">
            <Label htmlFor="confirm">
              Type <span className="font-mono">{slug}</span> to confirm
            </Label>
            <Input id="confirm" name="confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" variant="destructive" disabled={resetPending || confirm !== slug}>
              {resetPending ? "Removing…" : "Remove all files"}
            </Button>
            <Message state={reset} />
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
