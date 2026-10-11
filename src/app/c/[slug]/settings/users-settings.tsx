"use client";

import { useActionState, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { addMemberAction, changeRoleAction, removeMemberAction, type ActionState } from "./actions";

type Role = "admin" | "editor" | "viewer";

type Member = {
  userId: string;
  email: string;
  name: string | null;
  role: Role;
  isOwner: boolean;
  isActive: boolean;
  lastLogin: string | null;
};

const ROLE_HELP: Record<Role, string> = {
  admin: "Everything, including folders and users",
  editor: "Upload, file and manage their own uploads",
  viewer: "Browse, search and download",
};

function Message({ state }: { state: ActionState }) {
  if (!state) return null;
  return (
    <p role="status" className={state.error ? "text-destructive text-sm" : "text-muted-foreground text-sm"}>
      {state.error ?? state.ok}
    </p>
  );
}

function RoleOptions() {
  return (
    <>
      {(Object.keys(ROLE_HELP) as Role[]).map((r) => (
        <option key={r} value={r}>
          {r[0]!.toUpperCase() + r.slice(1)}
        </option>
      ))}
    </>
  );
}

export function UsersSettings({ slug, currentUserId, members }: { slug: string; currentUserId: string; members: Member[] }) {
  const [state, addAction, pending] = useActionState(addMemberAction.bind(null, slug), null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Users</CardTitle>
        <CardDescription>
          People sign in with their Microsoft work account. Owners are admins in every company and are managed from the command line.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <form action={addAction} className="flex flex-wrap items-end gap-3">
          <div className="grid min-w-64 flex-1 gap-1.5">
            <Label htmlFor="email">Work email</Label>
            <Input id="email" name="email" type="email" required placeholder="name@company.com" autoComplete="off" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="role">Role</Label>
            <NativeSelect id="role" name="role" defaultValue="viewer">
              <RoleOptions />
            </NativeSelect>
          </div>
          <Button type="submit" disabled={pending}>
            Add user
          </Button>
          <div className="basis-full">
            <Message state={state} />
          </div>
        </form>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Last sign-in</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((m) => (
              <MemberRow key={m.userId} slug={slug} member={m} isSelf={m.userId === currentUserId} />
            ))}
          </TableBody>
        </Table>
        <ul className="text-muted-foreground grid gap-1 text-xs">
          {(Object.entries(ROLE_HELP) as [Role, string][]).map(([role, help]) => (
            <li key={role}>
              <span className="text-foreground font-medium capitalize">{role}</span>: {help}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function MemberRow({ slug, member, isSelf }: { slug: string; member: Member; isSelf: boolean }) {
  const [roleState, roleAction, rolePending] = useActionState(changeRoleAction.bind(null, slug), null);
  const [removeState, removeAction, removePending] = useActionState(removeMemberAction.bind(null, slug), null);
  const roleForm = useRef<HTMLFormElement>(null);
  const editable = !member.isOwner && !isSelf;

  return (
    <TableRow>
      <TableCell className="whitespace-normal">
        <div dir="auto" className="font-medium">
          {member.name ?? member.email}
        </div>
        {member.name && <div className="text-muted-foreground text-xs">{member.email}</div>}
        <div className="mt-1 flex gap-1">
          {member.isOwner && <Badge variant="secondary">Owner</Badge>}
          {!member.isActive && <Badge variant="outline">Deactivated</Badge>}
          {isSelf && <Badge variant="outline">You</Badge>}
        </div>
      </TableCell>
      <TableCell>
        {editable ? (
          <form ref={roleForm} action={roleAction}>
            <input type="hidden" name="userId" value={member.userId} />
            <NativeSelect
              name="role"
              defaultValue={member.role}
              disabled={rolePending}
              aria-label={`Role for ${member.email}`}
              onChange={() => roleForm.current?.requestSubmit()}
            >
              <RoleOptions />
            </NativeSelect>
          </form>
        ) : (
          <span className="capitalize">{member.role}</span>
        )}
        <Message state={roleState?.error ? roleState : null} />
      </TableCell>
      <TableCell className="text-muted-foreground">{member.lastLogin ?? "Never"}</TableCell>
      <TableCell className="text-right">
        {editable && (
          <form
            action={removeAction}
            onSubmit={(e) => {
              if (!confirm(`Remove ${member.email} from this company?`)) e.preventDefault();
            }}
          >
            <input type="hidden" name="userId" value={member.userId} />
            <Button type="submit" variant="ghost" size="sm" disabled={removePending}>
              Remove
            </Button>
          </form>
        )}
        <Message state={removeState?.error ? removeState : null} />
      </TableCell>
    </TableRow>
  );
}
