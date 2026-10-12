"use client";

import { Lock } from "lucide-react";
import { useActionState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type { ActionState } from "./actions";
import { createFolderAction, grantAction, revokeAction, saveFolderAction, toggleFolderAction } from "./folder-actions";

export type FolderRow = {
  id: string;
  parentId: string | null;
  name: string;
  nameAr: string | null;
  description: string | null;
  access: "everyone" | "restricted";
  isActive: boolean;
  depth: number;
  path: string;
  grants: { userId: string; email: string; name: string | null; canWrite: boolean }[];
};

type GrantableUser = { userId: string; email: string; name: string | null };

function Message({ state }: { state: ActionState }) {
  if (!state) return null;
  return (
    <p role="status" className={state.error ? "text-destructive text-sm" : "text-muted-foreground text-sm"}>
      {state.error ?? state.ok}
    </p>
  );
}

function ParentSelect({ folders, exclude, defaultValue }: { folders: FolderRow[]; exclude?: string; defaultValue: string }) {
  return (
    <NativeSelect id={`parent-${exclude ?? "new"}`} name="parentId" defaultValue={defaultValue}>
      <option value="">Top level</option>
      {folders
        .filter((f) => f.id !== exclude)
        .map((f) => (
          <option key={f.id} value={f.id}>
            {f.path}
          </option>
        ))}
    </NativeSelect>
  );
}

const textarea =
  "border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px]";

export function FolderSettings({ slug, folders, grantable }: { slug: string; folders: FolderRow[]; grantable: GrantableUser[] }) {
  const [createState, createAction, creating] = useActionState(createFolderAction.bind(null, slug), null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Folders</CardTitle>
        <CardDescription>
          The description matters most: it says what belongs in a folder, and is what the AI will file by later. Moving a folder moves everything in it.
          A restricted folder, and everything under it, is visible only to admins and the people you grant.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <details className="rounded-lg border">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">New folder</summary>
          <form action={createAction} className="grid gap-3 border-t p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="new-name">Name</Label>
                <Input id="new-name" name="name" required maxLength={100} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="new-nameAr">Arabic name (optional)</Label>
                <Input id="new-nameAr" name="nameAr" maxLength={100} />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-description">What belongs here</Label>
              <textarea id="new-description" name="description" dir="auto" rows={2} maxLength={500} className={textarea} />
            </div>
            <div className="flex flex-wrap items-end gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="parent-new">Inside</Label>
                <ParentSelect folders={folders} defaultValue="" />
              </div>
              <Label className="pb-2">
                <input type="checkbox" name="restricted" /> Restricted
              </Label>
              <Button type="submit" disabled={creating}>
                Create folder
              </Button>
            </div>
            <Message state={createState} />
          </form>
        </details>

        <ul className="grid gap-2">
          {folders.map((f) => (
            <FolderItem key={f.id} slug={slug} folder={f} folders={folders} grantable={grantable} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function FolderItem({ slug, folder, folders, grantable }: { slug: string; folder: FolderRow; folders: FolderRow[]; grantable: GrantableUser[] }) {
  const [saveState, saveAction, saving] = useActionState(saveFolderAction.bind(null, slug), null);
  const [toggleState, toggleAction, toggling] = useActionState(toggleFolderAction.bind(null, slug), null);
  const [grantState, grantFormAction, granting] = useActionState(grantAction.bind(null, slug), null);
  const [revokeState, revokeFormAction, revoking] = useActionState(revokeAction.bind(null, slug), null);
  const granted = new Set(folder.grants.map((g) => g.userId));
  const candidates = grantable.filter((u) => !granted.has(u.userId));

  return (
    <li style={{ marginInlineStart: `${folder.depth * 1.25}rem` }}>
      <details className="rounded-lg border">
        <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
          <span dir="auto" className={folder.isActive ? "font-medium" : "text-muted-foreground font-medium line-through"}>
            {folder.name}
          </span>
          {folder.nameAr && (
            <span dir="rtl" className="text-muted-foreground">
              {folder.nameAr}
            </span>
          )}
          {folder.access === "restricted" && (
            <Badge variant="secondary">
              <Lock /> Restricted
            </Badge>
          )}
          {!folder.isActive && <Badge variant="outline">Inactive</Badge>}
        </summary>

        <div className="grid gap-5 border-t p-4">
          <form action={saveAction} className="grid gap-3">
            <input type="hidden" name="folderId" value={folder.id} />
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor={`name-${folder.id}`}>Name</Label>
                <Input id={`name-${folder.id}`} name="name" defaultValue={folder.name} required maxLength={100} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`nameAr-${folder.id}`}>Arabic name</Label>
                <Input id={`nameAr-${folder.id}`} name="nameAr" defaultValue={folder.nameAr ?? ""} maxLength={100} />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`description-${folder.id}`}>What belongs here</Label>
              <textarea id={`description-${folder.id}`} name="description" dir="auto" rows={2} maxLength={500} defaultValue={folder.description ?? ""} className={textarea} />
            </div>
            <div className="flex flex-wrap items-end gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor={`parent-${folder.id}`}>Inside</Label>
                <ParentSelect folders={folders} exclude={folder.id} defaultValue={folder.parentId ?? ""} />
              </div>
              <Label className="pb-2">
                <input type="checkbox" name="restricted" defaultChecked={folder.access === "restricted"} /> Restricted
              </Label>
              <Button type="submit" disabled={saving}>
                Save
              </Button>
            </div>
            <Message state={saveState} />
          </form>

          {folder.access === "restricted" && (
            <div className="grid gap-3 rounded-md bg-muted/40 p-3">
              <p className="text-sm font-medium">Who can open this folder</p>
              <p className="text-muted-foreground text-xs">Admins and owners always can. Only people you add here can otherwise, and only those with “can add files” may upload.</p>
              {folder.grants.length === 0 ? (
                <p className="text-muted-foreground text-sm">Nobody else yet.</p>
              ) : (
                <ul className="grid gap-1.5">
                  {folder.grants.map((g) => (
                    <li key={g.userId} className="flex items-center justify-between gap-3 text-sm">
                      <span dir="auto" className="min-w-0 truncate">
                        {g.name ?? g.email}
                        <span className="text-muted-foreground"> · {g.canWrite ? "can add files" : "view only"}</span>
                      </span>
                      <form action={revokeFormAction}>
                        <input type="hidden" name="folderId" value={folder.id} />
                        <input type="hidden" name="userId" value={g.userId} />
                        <Button type="submit" variant="ghost" size="sm" disabled={revoking}>
                          Remove
                        </Button>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
              <Message state={revokeState} />
              {candidates.length > 0 && (
                <form action={grantFormAction} className="flex flex-wrap items-center gap-3">
                  <input type="hidden" name="folderId" value={folder.id} />
                  <NativeSelect name="userId" defaultValue="" aria-label="Person to give access" required>
                    <option value="" disabled>
                      Add a person…
                    </option>
                    {candidates.map((u) => (
                      <option key={u.userId} value={u.userId}>
                        {u.name ?? u.email}
                      </option>
                    ))}
                  </NativeSelect>
                  <Label>
                    <input type="checkbox" name="canWrite" /> Can add files
                  </Label>
                  <Button type="submit" size="sm" disabled={granting}>
                    Give access
                  </Button>
                </form>
              )}
              <Message state={grantState} />
            </div>
          )}

          <form action={toggleAction} className="flex items-center gap-3">
            <input type="hidden" name="folderId" value={folder.id} />
            <input type="hidden" name="active" value={folder.isActive ? "0" : "1"} />
            <Button type="submit" variant="outline" size="sm" disabled={toggling}>
              {folder.isActive ? "Deactivate" : "Reactivate"}
            </Button>
            <span className="text-muted-foreground text-xs">
              {folder.isActive ? "Hides it and its subfolders. Files stay readable; nothing new can be added." : "Makes it available again."}
            </span>
            <Message state={toggleState} />
          </form>
        </div>
      </details>
    </li>
  );
}
