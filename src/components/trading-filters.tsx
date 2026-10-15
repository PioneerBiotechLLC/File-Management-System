"use client";

import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import type { BrowseResult } from "@/lib/browse";

/**
 * Browsing by dropdowns, each offering only what still has files given the others. Commercial:
 * year, Customers/Suppliers, company, kind. Technical: manufacturer, material, kind. Changing one
 * reloads the page with the new address, so the server recomputes the lists and the files.
 */
export function TradingFilters({ slug, browse }: { slug: string; browse: BrowseResult }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const { filter, tree } = browse;

  type Param = "tree" | "year" | "side" | "party" | "material" | "kind";
  const go = (change: Partial<Record<Param, string>>) => {
    const params = new URLSearchParams();
    const next: Record<Param, string> = {
      tree: tree === "technical" ? "technical" : "",
      year: filter.year ? String(filter.year) : "",
      side: filter.side ?? "",
      party: filter.partyId ?? "",
      material: filter.materialId ?? "",
      kind: filter.docKind ?? "",
      ...change,
    };
    for (const [key, value] of Object.entries(next)) if (value) params.set(key, value);
    const text = params.toString();
    start(() => router.push(`/c/${slug}${text ? `?${text}` : ""}`));
  };

  const label = (text: string, count: number) => `${text} (${count.toLocaleString("en")})`;
  const party = browse.parties.find((p) => p.value === filter.partyId);
  const bothTrees = browse.trees.trading && browse.trees.technical;

  return (
    <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center" aria-busy={pending}>
      {(bothTrees || tree === "technical") && (
        <NativeSelect
          value={tree}
          onChange={(e) => go({ tree: e.target.value === "technical" ? "technical" : "", year: "", side: "", party: "", material: "", kind: "" })}
          aria-label="Which documents"
          className="col-span-2 sm:col-span-1"
        >
          <option value="trading">Commercial documents</option>
          <option value="technical">Technical documents</option>
        </NativeSelect>
      )}

      {tree === "trading" ? (
        <>
          <NativeSelect value={filter.year ?? ""} onChange={(e) => go({ year: e.target.value })} aria-label="Year">
            <option value="">All years</option>
            {browse.years.map((y) => (
              <option key={y.value} value={y.value}>
                {label(y.label, y.count)}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect
            value={filter.side ?? ""}
            onChange={(e) => {
              const side = e.target.value;
              // A company belongs to one side; keep it only if it is still on the chosen side.
              go({ side, party: party && (!side || party.side === side) ? party.value : "" });
            }}
            aria-label="Customers or suppliers"
          >
            <option value="">Customers & suppliers</option>
            {browse.sides.map((s) => (
              <option key={s.value} value={s.value}>
                {label(s.label, s.count)}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect value={filter.partyId ?? ""} onChange={(e) => go({ party: e.target.value })} aria-label="Company" className="col-span-2 sm:col-span-1 sm:max-w-72" dir="auto">
            <option value="">All companies</option>
            {browse.parties.map((p) => (
              <option key={p.value} value={p.value}>
                {label(filter.side ? p.label : `${p.label} · ${p.side === "customer" ? "customer" : "supplier"}`, p.count)}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect value={filter.docKind ?? ""} onChange={(e) => go({ kind: e.target.value })} aria-label="Document type">
            <option value="">All types</option>
            {browse.docKinds.map((k) => (
              <option key={k.value} value={k.value}>
                {label(k.label, k.count)}
              </option>
            ))}
          </NativeSelect>
        </>
      ) : (
        <>
          <NativeSelect
            value={filter.partyId ?? ""}
            onChange={(e) => {
              const maker = e.target.value;
              const material = browse.materials.find((m) => m.value === filter.materialId);
              go({ party: maker, material: material && (!maker || material.partyId === maker) ? material.value : "" });
            }}
            aria-label="Manufacturer"
            className="sm:max-w-72"
            dir="auto"
          >
            <option value="">All manufacturers</option>
            {browse.makers.map((p) => (
              <option key={p.value} value={p.value}>
                {label(p.label, p.count)}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect value={filter.materialId ?? ""} onChange={(e) => go({ material: e.target.value })} aria-label="Material" className="col-span-2 sm:col-span-1 sm:max-w-80" dir="auto">
            <option value="">All materials</option>
            {browse.materials.map((m) => (
              <option key={m.value} value={m.value}>
                {label(filter.partyId ? m.label : `${m.label} · ${browse.makers.find((p) => p.value === m.partyId)?.label ?? ""}`, m.count)}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect value={filter.docKind ?? ""} onChange={(e) => go({ kind: e.target.value })} aria-label="Document type">
            <option value="">All types</option>
            {browse.techKinds.map((k) => (
              <option key={k.value} value={k.value}>
                {label(k.label, k.count)}
              </option>
            ))}
          </NativeSelect>
        </>
      )}

      {browse.active && (
        <Button type="button" variant="ghost" size="sm" onClick={() => go({ year: "", side: "", party: "", material: "", kind: "" })}>
          <X />
          Clear
        </Button>
      )}
    </div>
  );
}
