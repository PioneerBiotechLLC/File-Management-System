import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LOG_CATEGORIES, describeEntry, listAuditLog, type LogCategory } from "@/lib/audit-log";
import { db } from "@/lib/db";
import { folderPaths } from "@/lib/folders";
import { can } from "@/lib/permissions";
import { companyContext } from "@/lib/session";

export const metadata = { title: "Log" };

type SearchParams = { who?: string; type?: string; page?: string };

function href(slug: string, params: SearchParams, page: number): string {
  const query = new URLSearchParams();
  if (params.who) query.set("who", params.who);
  if (params.type) query.set("type", params.type);
  if (page > 1) query.set("page", String(page));
  const text = query.toString();
  return `/c/${slug}/log${text ? `?${text}` : ""}`;
}

export default async function LogPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> }) {
  const { slug } = await params;
  const query = await searchParams;
  const { org, role, user } = await companyContext(slug);
  if (!can(role, "log.view")) notFound();

  const prisma = db();
  const category = query.type && query.type in LOG_CATEGORIES ? (query.type as LogCategory) : undefined;
  const [log, folders] = await Promise.all([
    listAuditLog(prisma, {
      orgId: org.id,
      includeUnscoped: user.isOwner,
      email: query.who?.trim().toLowerCase() || undefined,
      category,
      page: Number(query.page) || 1,
    }),
    prisma.folder.findMany({ where: { orgId: org.id }, select: { id: true, parentId: true, name: true } }),
  ]);
  const lookups = { files: log.files, folders: folderPaths(folders), users: log.users };
  const formatTime = new Intl.DateTimeFormat("en-GB", { timeZone: org.timezone, dateStyle: "medium", timeStyle: "short" });

  return (
    <div className="grid gap-4">
      <div>
        <h1 className="text-xl font-semibold">Log</h1>
        <p className="text-muted-foreground text-sm">Everything people have done in {org.name}, newest first, with the email address of who did it.</p>
      </div>

      <form className="flex flex-wrap items-end gap-2" action={`/c/${slug}/log`}>
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground text-xs">Person</span>
          <NativeSelect name="who" defaultValue={query.who ?? ""} className="max-w-72">
            <option value="">Everyone</option>
            {log.people.map((email) => (
              <option key={email} value={email}>
                {email}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground text-xs">Type</span>
          <NativeSelect name="type" defaultValue={category ?? ""}>
            <option value="">All actions</option>
            {Object.entries(LOG_CATEGORIES).map(([key, c]) => (
              <option key={key} value={key}>
                {c.label}
              </option>
            ))}
          </NativeSelect>
        </label>
        <Button type="submit" variant="outline">
          Show
        </Button>
        {(query.who || category) && (
          <Button asChild variant="ghost">
            <Link href={`/c/${slug}/log`}>Clear</Link>
          </Button>
        )}
      </form>

      {log.items.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">Nothing matches.</p>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-44">When</TableHead>
                <TableHead className="w-64">Who</TableHead>
                <TableHead>What</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {log.items.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="text-muted-foreground align-top whitespace-nowrap">{formatTime.format(entry.createdAt)}</TableCell>
                  <TableCell className="max-w-64 truncate align-top">{entry.userEmail}</TableCell>
                  <TableCell className="align-top whitespace-normal">
                    {describeEntry(entry, lookups).map((part, i) => {
                      if (typeof part === "string") return <span key={i}>{part}</span>;
                      if ("folder" in part)
                        return (
                          <span key={i} dir="auto" className="font-medium">
                            {part.folder}
                          </span>
                        );
                      return part.link ? (
                        <Link key={i} href={`/c/${slug}/files/${part.file}`} dir="auto" className="font-medium hover:underline">
                          {part.name}
                        </Link>
                      ) : (
                        <span key={i} dir="auto" className="font-medium">
                          {part.name}
                        </span>
                      );
                    })}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {log.pages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Page {log.page} of {log.pages} · {log.total} entries
          </span>
          <div className="flex gap-2">
            {log.page > 1 && (
              <Button asChild variant="outline" size="sm">
                <Link href={href(slug, query, log.page - 1)}>Newer</Link>
              </Button>
            )}
            {log.page < log.pages && (
              <Button asChild variant="outline" size="sm">
                <Link href={href(slug, query, log.page + 1)}>Older</Link>
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
