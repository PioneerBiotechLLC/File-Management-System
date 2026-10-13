"use client";

import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import type { BrowseResult } from "@/lib/browse";

/**
 * Year, Customers/Suppliers, company and document kind, each offering only what still has files
 * given the other three. Changing one reloads the page with the new address, so the server
 * recomputes the lists and the list of files.
 */
export function TradingFilters({ slug, browse }: { slug: string; browse: BrowseResult }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const { filter } = browse;

  const go = (change: Partial<Record<"year" | "side" | "party" | "kind", string>>) => {
    const params = new URLSearchParams();
    const next = {
      year: filter.year ? String(filter.year) : "",
      side: filter.side ?? "",
      party: filter.partyId ?? "",
      kind: filter.docKind ?? "",
      ...change,
    };
    for (const [key, value] of Object.entries(next)) if (value) params.set(key, value);
    const text = params.toString();
    start(() => router.push(`/c/${slug}${text ? `?${text}` : ""}`));
  };

  const label = (text: string, count: number) => `${text} (${count.toLocaleString("en")})`;
  const party = browse.parties.find((p) => p.value === filter.partyId);

  return (
    <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center" aria-busy={pending}>
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
      {browse.active && (
        <Button type="button" variant="ghost" size="sm" onClick={() => go({ year: "", side: "", party: "", kind: "" })}>
          <X />
          Clear
        </Button>
      )}
    </div>
  );
}
