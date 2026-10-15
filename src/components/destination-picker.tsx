"use client";

import { Building2, FlaskConical, FolderTree } from "lucide-react";
import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import {
  DOC_KINDS,
  SIDES,
  SIDE_FOLDERS,
  TECH_KINDS,
  cleanPartyName,
  filingYears,
  matchMaterial,
  matchParty,
  technicalPath,
  tradingPath,
  type Destination,
  type DocKindId,
  type MaterialChoice,
  type PartyChoice,
  type PartySide,
  type TechKindId,
} from "@/lib/file-kinds";
import { cn } from "@/lib/utils";

/**
 * Chooses where a file goes: a customer or supplier (year, side, company, kind of document), a
 * material's technical documents (manufacturer, material, kind), or one of the company's own
 * folders. Company, material and kind folders are created when filed.
 */

export type DestinationDraft = {
  mode: "trading" | "technical" | "folder";
  year: number;
  side: PartySide;
  partyName: string;
  docKind: DocKindId;
  /** Technical: the manufacturer, the material and the kind. */
  makerName: string;
  materialName: string;
  techKind: TechKindId;
  folderId: string;
};

export type DraftDefaults = { year: number; docKind: DocKindId; techKind?: TechKindId; technical?: boolean };

export function draftFrom(destination: Destination | null, fallback: DraftDefaults): DestinationDraft {
  const base: DestinationDraft = {
    mode: fallback.technical ? "technical" : "trading",
    year: fallback.year,
    side: "customer",
    partyName: "",
    docKind: fallback.docKind,
    makerName: "",
    materialName: "",
    techKind: fallback.techKind ?? "coa",
    folderId: "",
  };
  if (!destination) return base;
  if (destination.kind === "folder") return { ...base, mode: "folder", folderId: destination.folderId };
  if (destination.kind === "technical") {
    return { ...base, mode: "technical", makerName: destination.partyName, materialName: destination.materialName, techKind: destination.docKind };
  }
  return { ...base, mode: "trading", year: destination.year, side: destination.side, partyName: destination.partyName, docKind: destination.docKind };
}

export type ResolvedDraft = { destination: Destination; path: string; newParty: boolean; newMaterial: boolean };

/** The destination to file with, whether it names a new company or material, and its path; null until complete. */
export function resolveDraft(draft: DestinationDraft, parties: PartyChoice[], folders: { id: string; path: string }[], materials: MaterialChoice[] = []): ResolvedDraft | null {
  if (draft.mode === "folder") {
    const folder = folders.find((f) => f.id === draft.folderId);
    return folder ? { destination: { kind: "folder", folderId: folder.id }, path: folder.path, newParty: false, newMaterial: false } : null;
  }
  if (draft.mode === "technical") {
    const maker = cleanPartyName(draft.makerName);
    const material = cleanPartyName(draft.materialName);
    if (!maker || !material) return null;
    const party = matchParty(parties, "supplier", maker);
    const known = party ? matchMaterial(materials, party.id, material) : null;
    const destination: Destination = {
      kind: "technical",
      partyId: party?.id ?? null,
      partyName: party?.name ?? maker,
      materialId: known?.id ?? null,
      materialName: known?.name ?? material,
      docKind: draft.techKind,
    };
    return { destination, path: technicalPath(destination), newParty: !party, newMaterial: !known };
  }
  const name = cleanPartyName(draft.partyName);
  if (!name) return null;
  const party = matchParty(parties, draft.side, name);
  const destination: Destination = { kind: "trading", year: draft.year, side: draft.side, partyId: party?.id ?? null, partyName: party?.name ?? name, docKind: draft.docKind };
  return { destination, path: tradingPath(destination), newParty: !party, newMaterial: false };
}

export function DestinationPicker({
  draft,
  onChange,
  parties,
  materials = [],
  folders,
  autoFocus,
}: {
  draft: DestinationDraft;
  onChange: (draft: DestinationDraft) => void;
  parties: PartyChoice[];
  materials?: MaterialChoice[];
  folders: { id: string; path: string }[];
  autoFocus?: boolean;
}) {
  const id = useId();
  const set = (patch: Partial<DestinationDraft>) => onChange({ ...draft, ...patch });
  const sideLabel = SIDE_FOLDERS[draft.side].label.toLowerCase();
  const names = parties.filter((p) => p.side === draft.side);
  const makers = parties.filter((p) => p.side === "supplier");
  const maker = draft.makerName ? matchParty(parties, "supplier", draft.makerName) : null;
  const materialNames = maker ? materials.filter((m) => m.partyId === maker.id) : [];
  const resolved = resolveDraft(draft, parties, folders, materials);

  return (
    <div className="grid gap-3">
      <div role="radiogroup" aria-label="Where it goes" className="grid grid-cols-3 gap-2">
        {(
          [
            ["trading", Building2, "Customer or supplier"],
            ["technical", FlaskConical, "Material (technical)"],
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
              "flex items-center justify-center gap-2 rounded-md border px-2 py-2 text-sm",
              draft.mode === mode ? "border-brand bg-accent font-medium" : "text-muted-foreground hover:bg-accent",
            )}
          >
            <Icon className="size-4 shrink-0" />
            <span className="truncate">{label}</span>
          </button>
        ))}
      </div>

      {draft.mode === "trading" && (
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
      )}

      {draft.mode === "technical" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-maker`}>Manufacturer</Label>
            <Input
              id={`${id}-maker`}
              list={`${id}-makers`}
              dir="auto"
              value={draft.makerName}
              maxLength={100}
              autoFocus={autoFocus}
              placeholder="Who makes the material"
              onChange={(e) => set({ makerName: e.target.value })}
            />
            <datalist id={`${id}-makers`}>
              {makers.map((p) => (
                <option key={p.id} value={p.name} />
              ))}
            </datalist>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-material`}>Material</Label>
            <Input
              id={`${id}-material`}
              list={`${id}-materials`}
              dir="auto"
              value={draft.materialName}
              maxLength={100}
              placeholder="Name and grade, e.g. Microcrystalline Cellulose 102"
              onChange={(e) => set({ materialName: e.target.value })}
            />
            <datalist id={`${id}-materials`}>
              {materialNames.map((m) => (
                <option key={m.id} value={m.name} />
              ))}
            </datalist>
          </div>
          {resolved && resolved.destination.kind === "technical" && (resolved.newParty || resolved.newMaterial) && (
            <p className="text-muted-foreground text-xs sm:col-span-2">
              <span className="font-medium text-amber-700">
                {resolved.newParty ? `New supplier “${resolved.destination.partyName}”` : `New material “${resolved.destination.materialName}”`}: folders will be created.
              </span>
            </p>
          )}
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor={`${id}-tech-kind`}>Document</Label>
            <NativeSelect id={`${id}-tech-kind`} value={draft.techKind} onChange={(e) => set({ techKind: e.target.value as TechKindId })}>
              {TECH_KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
      )}

      {draft.mode === "folder" && (
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
