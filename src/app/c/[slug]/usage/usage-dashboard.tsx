"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { UsageReport, UsageRow } from "@/lib/ai-limits";
import { setCompanyLimitsAction, setMemberLimitsAction } from "./actions";

const usd = (value: number) => `$${value.toFixed(2)}`;
const filesRead = (n: number) => `${n} ${n === 1 ? "file" : "files"} read`;

/** "$1.20 / $2.00", red once the cap is reached. */
function Spend({ spent, cap }: { spent: number; cap: number }) {
  const reached = spent >= cap;
  return (
    <span className={reached ? "text-destructive font-medium" : undefined}>
      {usd(spent)} <span className="text-muted-foreground">/ {usd(cap)}</span>
    </span>
  );
}

function LimitsForm({
  initial,
  defaults,
  onSave,
  onCancel,
}: {
  initial: { dailyUsd: number | null; monthlyUsd: number | null };
  defaults: { dailyUsd: number; monthlyUsd: number };
  onSave: (values: { dailyUsd: string; monthlyUsd: string }) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      action={(formData) =>
        start(async () => {
          const problem = await onSave({ dailyUsd: String(formData.get("dailyUsd") ?? ""), monthlyUsd: String(formData.get("monthlyUsd") ?? "") });
          if (problem) setError(problem);
        })
      }
    >
      <div className="grid gap-1">
        <Label htmlFor="dailyUsd" className="text-xs">
          Per day ($)
        </Label>
        <Input id="dailyUsd" name="dailyUsd" inputMode="decimal" className="w-24" defaultValue={initial.dailyUsd ?? ""} placeholder={String(defaults.dailyUsd)} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="monthlyUsd" className="text-xs">
          Per month ($)
        </Label>
        <Input id="monthlyUsd" name="monthlyUsd" inputMode="decimal" className="w-24" defaultValue={initial.monthlyUsd ?? ""} placeholder={String(defaults.monthlyUsd)} />
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        Save
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
        Cancel
      </Button>
      {error && (
        <p role="alert" className="text-destructive basis-full text-xs">
          {error}
        </p>
      )}
    </form>
  );
}

export function UsageDashboard({ slug, report }: { slug: string; report: UsageReport }) {
  const router = useRouter();
  const [editingCompany, setEditingCompany] = useState(false);
  const { company } = report;

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Company</CardTitle>
          <CardDescription>
            Everything the AI has cost the company. The limits apply to editors and viewers; what admins and owners spend is recorded but never counted
            against them. Leave a limit empty to use the default.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Today</dt>
              <dd className="text-right">
                <Spend spent={company.counted.today.usd} cap={company.limits.dailyUsd} /> · {filesRead(company.today.reads)}
                {company.today.usd > company.counted.today.usd && (
                  <span className="text-muted-foreground block text-xs">{usd(company.today.usd)} in all, with admins</span>
                )}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">This month</dt>
              <dd className="text-right">
                <Spend spent={company.counted.month.usd} cap={company.limits.monthlyUsd} /> · {filesRead(company.month.reads)}
                {company.month.usd > company.counted.month.usd && (
                  <span className="text-muted-foreground block text-xs">{usd(company.month.usd)} in all, with admins</span>
                )}
              </dd>
            </div>
          </dl>
          {editingCompany ? (
            <LimitsForm
              initial={{ dailyUsd: company.overrides.aiDailyUsd, monthlyUsd: company.overrides.aiMonthlyUsd }}
              defaults={report.defaults.company}
              onCancel={() => setEditingCompany(false)}
              onSave={async (values) => {
                const result = await setCompanyLimitsAction(slug, values);
                if (!result.ok) return result.error;
                setEditingCompany(false);
                router.refresh();
                return null;
              }}
            />
          ) : (
            <div>
              <Button size="sm" variant="outline" onClick={() => setEditingCompany(true)}>
                Change company limits
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>People</CardTitle>
          <CardDescription>
            Each person&apos;s own limits. The default is {usd(report.defaults.member.dailyUsd)} a day and {usd(report.defaults.member.monthlyUsd)} a month; no limit here
            can go above {usd(report.ceilings.dailyUsd)} a day or {usd(report.ceilings.monthlyUsd)} a month.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Person</TableHead>
                <TableHead className="text-right">Files read</TableHead>
                <TableHead className="text-right">Searches</TableHead>
                <TableHead>Today</TableHead>
                <TableHead>This month</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.people.map((p) => (
                <PersonRow key={p.userId} slug={slug} person={p} defaults={report.defaults.member} />
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function PersonRow({ slug, person, defaults }: { slug: string; person: UsageRow; defaults: { dailyUsd: number; monthlyUsd: number } }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const custom = person.overrides && (person.overrides.aiDailyUsd !== null || person.overrides.aiMonthlyUsd !== null);

  return (
    <TableRow>
      <TableCell className="whitespace-normal">
        <div dir="auto" className="font-medium">
          {person.name ?? person.email}
        </div>
        {person.name && <div className="text-muted-foreground text-xs">{person.email}</div>}
        <div className="mt-1 flex gap-1">
          {person.isOwner && <Badge variant="secondary">Owner</Badge>}
          {person.exempt && <Badge variant="outline">No limit</Badge>}
          {!person.isActive && <Badge variant="outline">Deactivated</Badge>}
          {custom && <Badge variant="outline">Own limits</Badge>}
        </div>
      </TableCell>
      <TableCell className="text-right">
        {person.today.reads} <span className="text-muted-foreground">/ {person.month.reads}</span>
      </TableCell>
      <TableCell className="text-right">
        {person.today.searches} <span className="text-muted-foreground">/ {person.month.searches}</span>
      </TableCell>
      <TableCell>{person.exempt ? usd(person.today.usd) : <Spend spent={person.today.usd} cap={person.limits.dailyUsd} />}</TableCell>
      <TableCell>{person.exempt ? usd(person.month.usd) : <Spend spent={person.month.usd} cap={person.limits.monthlyUsd} />}</TableCell>
      <TableCell className="whitespace-normal">
        {person.exempt ? (
          <span className="text-muted-foreground text-xs">Not counted</span>
        ) : person.overrides === null ? (
          <span className="text-muted-foreground text-xs">Default limits</span>
        ) : editing ? (
          <LimitsForm
            initial={{ dailyUsd: person.overrides.aiDailyUsd, monthlyUsd: person.overrides.aiMonthlyUsd }}
            defaults={defaults}
            onCancel={() => setEditing(false)}
            onSave={async (values) => {
              const result = await setMemberLimitsAction(slug, { userId: person.userId, ...values });
              if (!result.ok) return result.error;
              setEditing(false);
              router.refresh();
              return null;
            }}
          />
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Change limits
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}
