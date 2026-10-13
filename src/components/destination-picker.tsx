"use client";

import { Building2, FolderTree } from "lucide-react";
import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import {
  DOC_KINDS,
  SIDES,
  SIDE_FOLDERS,
  cleanPartyName,
  filingYears,
  matchParty,
  tradingPath,
  type Destination,
  type DocKindId,
  type PartyChoice,
  type PartySide,
} from "@/lib/file-kinds";
import { cn } from "@/lib/utils";

/**
 * Chooses where a file goes: a customer or supplier (year, side, company, kind of document; the
 * folders are created when filed) or one of the company's own folders.
 */

export type DestinationDraft = {
  mode: "trading" | "folder";
  year: number;
  side: PartySide;
  partyName: string;
  docKind: DocKindId;
  folderId: string;
};

export function draftFrom(destination: Destination | null, fallback: { year: number; docKind: DocKindId }): DestinationDraft {
  const base: DestinationDraft = { mode: "trading", year: fallback.year, side: "customer", partyName: "", docKind: fallback.docKind, folderId: "" };
  if (!destination) return base;
  if (destination.kind === "folder") return { ...base, mode: "folder", folderId: destination.folderId };
  return { ...base, year: destination.year, side: destination.side, partyName: destination.partyName, docKind: destination.docKind };
}

/** The destination to file with, the existing party it names (if any), and its path; null until complete. */
export function resolveDraft(draft: DestinationDraft, parties: PartyChoice[], folders: { id: string; path: string }[]) {
  if (draft.mode === "folder") {
    const folder = folders.find((f) => f.id === draft.folderId);
    return folder ? { destination: { kind: "folder", folderId: folder.id } as Destination, path: folder.path, newParty: false } : null;
  }
  const name = cleanPartyName(draft.partyName);
  if (!name) return null;
  const party = matchParty(parties, draft.side, name);
  const destination: Destination = { kind: "trading", year: draft.year, side: draft.side, partyId: party?.id ?? null, partyName: party?.name ?? name, docKind: draft.docKind };
  return { destination, path: tradingPath(destination), newParty: !party };
}

export function DestinationPicker({
  draft,
  onChange,
  parties,
  folders,
  autoFocus,
}: {
  draft: DestinationDraft;
  onChange: (draft: DestinationDraft) => void;
  parties: PartyChoice[];
  folders: { id: string; path: string }[];
  autoFocus?: boolean;
}) {
  const id = useId();
  const set = (patch: Partial<DestinationDraft>) => onChange({ ...draft, ...patch });
  const sideLabel = SIDE_FOLDERS[draft.side].label.toLowerCase();
  const names = parties.filter((p) => p.side === draft.side);
  const resolved = resolveDraft(draft, parties, folders);

  return (
    <div className="grid gap-3">
      <div role="radiogroup" aria-label="Where it goes" className="grid grid-cols-2 gap-2">
        {(
          [
            ["trading", Building2, "Customer or supplier"],
            ["folder", FolderTree, "Company folder"],
          ] as const
        ).map(([mode, Icon, label]) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={draft.mode === mode}
            onClick={() => set({ mode })}
            className={cn(
              "flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm",
              draft.mode === mode ? "border-brand bg-accent font-medium" : "text-muted-foreground hover:bg-accent",
            )}
          >
            <Icon className="size-4" />
            {label}
          </button>
        ))}
      </div>

      {draft.mode === "trading" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-side`}>Customer or supplier</Label>
            <NativeSelect id={`${id}-side`} value={draft.side} onChange={(e) => set({ side: e.target.value as PartySide })}>
              {SIDES.map((side) => (
                <option key={side} value={side}>
                  {SIDE_FOLDERS[side].label}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-year`}>Year</Label>
            <NativeSelect id={`${id}-year`} value={draft.year} onChange={(e) => set({ year: Number(e.target.value) })}>
              {filingYears().map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor={`${id}-party`}>{SIDE_FOLDERS[draft.side].label} name</Label>
            <Input
              id={`${id}-party`}
              list={`${id}-parties`}
              dir="auto"
              value={draft.partyName}
              maxLength={100}
              autoFocus={autoFocus}
              placeholder={`Start typing; pick an existing ${sideLabel} or write a new one`}
              onChange={(e) => set({ partyName: e.target.value })}
            />
            <datalist id={`${id}-parties`}>
              {names.map((p) => (
                <option key={p.id} value={p.name} />
              ))}
            </datalist>
            {resolved && resolved.destination.kind === "trading" && (
              <p className="text-muted-foreground text-xs">
                {resolved.newParty ? (
                  <span className="font-medium text-amber-700">New {sideLabel}: a folder will be created for “{resolved.destination.partyName}”.</span>
                ) : (
                  <>Existing {sideLabel}: {resolved.destination.partyName}</>
                )}
              </p>
            )}
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor={`${id}-kind`}>Document</Label>
            <NativeSelect id={`${id}-kind`} value={draft.docKind} onChange={(e) => set({ docKind: e.target.value as DocKindId })}>
              {DOC_KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
      ) : (
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-folder`}>Folder</Label>
          <NativeSelect id={`${id}-folder`} value={draft.folderId} onChange={(e) => set({ folderId: e.target.value })} autoFocus={autoFocus}>
            <option value="" disabled>
              Choose a folder…
            </option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.path}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}

      <p className="text-muted-foreground text-sm">
        Goes to: {resolved ? <span className="text-foreground font-medium">{resolved.path}</span> : "—"}
      </p>
    </div>
  );
}
