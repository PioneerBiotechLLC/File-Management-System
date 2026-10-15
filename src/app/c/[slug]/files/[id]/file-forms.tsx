"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteFileAction, fileToAction, renameFileAction, updateDetailsAction } from "@/app/c/[slug]/actions";
import { DestinationPicker, draftFrom, resolveDraft } from "@/components/destination-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { DOC_TYPES, DOC_TYPE_LABELS } from "@/lib/doc-types";
import type { Destination, DocKindId, MaterialChoice, PartyChoice, TechKindId } from "@/lib/file-kinds";

type Notice = { ok: boolean; text: string } | null;

function NoticeLine({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <p role="status" className={notice.ok ? "text-muted-foreground text-sm" : "text-destructive text-sm"}>
      {notice.text}
    </p>
  );
}

export function MoveForm({
  slug,
  fileId,
  current,
  defaults,
  parties,
  materials,
  folders,
}: {
  slug: string;
  fileId: string;
  /** Where the file is now; null while unfiled. */
  current: Destination | null;
  defaults: { year: number; docKind: DocKindId; techKind: TechKindId; technical: boolean };
  parties: PartyChoice[];
  materials: MaterialChoice[];
  folders: { id: string; path: string }[];
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(() => draftFrom(current, defaults));
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, start] = useTransition();
  const resolved = resolveDraft(draft, parties, folders, materials);
  const unchanged = resolved !== null && current !== null && JSON.stringify(resolved.destination) === JSON.stringify(current);

  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!resolved) return;
        start(async () => {
          const result = await fileToAction(slug, { fileId, destination: resolved.destination });
          setNotice(result.ok ? { ok: true, text: current ? "Moved." : "Filed." } : { ok: false, text: result.error });
          if (result.ok) router.refresh();
        });
      }}
    >
      <Label>{current ? "Move to" : "File in"}</Label>
      <DestinationPicker draft={draft} onChange={setDraft} parties={parties} materials={materials} folders={folders} />
      <div>
        <Button type="submit" disabled={pending || !resolved || unchanged}>
          {current ? "Move" : "File it"}
        </Button>
      </div>
      <NoticeLine notice={notice} />
    </form>
  );
}

export function DetailsForm({
  slug,
  fileId,
  initial,
}: {
  slug: string;
  fileId: string;
  initial: { title: string; summary: string; docType: string; docDate: string; tags: string };
}) {
  const router = useRouter();
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, start] = useTransition();

  return (
    <form
      className="grid gap-4"
      action={(formData) =>
        start(async () => {
          const field = (name: string) => String(formData.get(name) ?? "");
          const result = await updateDetailsAction(slug, {
            fileId,
            title: field("title"),
            summary: field("summary"),
            docType: field("docType"),
            docDate: field("docDate"),
            tags: field("tags"),
          });
          setNotice(result.ok ? { ok: true, text: "Saved." } : { ok: false, text: result.error });
          if (result.ok) router.refresh();
        })
      }
    >
      <div className="grid gap-1.5">
        <Label htmlFor="title">Title</Label>
        <Input id="title" name="title" defaultValue={initial.title} maxLength={200} placeholder="e.g. Quotation QT-2291 for Gulf Pharmacy" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="summary">Summary</Label>
        <textarea
          id="summary"
          name="summary"
          dir="auto"
          rows={3}
          maxLength={2000}
          defaultValue={initial.summary}
          placeholder="What this document is, in a sentence or two"
          className="border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 min-h-20 w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px]"
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="docType">Type</Label>
          <NativeSelect id="docType" name="docType" defaultValue={initial.docType}>
            <option value="">Not set</option>
            {DOC_TYPES.map((t) => (
              <option key={t} value={t}>
                {DOC_TYPE_LABELS[t]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="docDate">Document date</Label>
          <Input id="docDate" name="docDate" type="date" defaultValue={initial.docDate} />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="tags">Tags</Label>
        <Input id="tags" name="tags" defaultValue={initial.tags} placeholder="customer, product, batch 2291 (separate with commas)" />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          Save details
        </Button>
        <NoticeLine notice={notice} />
      </div>
    </form>
  );
}

export function RenameAndDelete({
  slug,
  fileId,
  name,
  canRename,
  canDelete,
  backHref,
}: {
  slug: string;
  fileId: string;
  name: string;
  canRename: boolean;
  canDelete: boolean;
  backHref: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, start] = useTransition();

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        {canRename && !editing && (
          <Button variant="outline" onClick={() => setEditing(true)}>
            Rename
          </Button>
        )}
        {canDelete && (
          <Button
            variant="outline"
            className="text-destructive"
            disabled={pending}
            onClick={() => {
              if (!confirm(`Delete “${name}”? You can restore it from Deleted for 30 days.`)) return;
              start(async () => {
                const result = await deleteFileAction(slug, { fileId });
                if (result.ok) router.push(backHref);
                else setNotice({ ok: false, text: result.error });
              });
            }}
          >
            Delete
          </Button>
        )}
      </div>
      {editing && (
        <form
          className="flex gap-2"
          action={(formData) =>
            start(async () => {
              const result = await renameFileAction(slug, { fileId, name: String(formData.get("name") ?? "") });
              if (result.ok) {
                setEditing(false);
                setNotice(null);
                router.refresh();
              } else setNotice({ ok: false, text: result.error });
            })
          }
        >
          <Input name="name" defaultValue={name} required maxLength={200} aria-label="File name" autoFocus />
          <Button type="submit" disabled={pending}>
            Save
          </Button>
          <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </form>
      )}
      <NoticeLine notice={notice} />
    </div>
  );
}
