import type { Role } from "@/generated/prisma/enums";

export const ROLES = ["admin", "editor", "viewer"] as const satisfies readonly Role[];

export const ACTIONS = [
  "file.view",
  "file.download",
  "file.search",
  "file.upload",
  "file.rename",
  "file.move",
  "file.delete",
  "file.restore",
  "file.retry",
  "review.accept",
  "folder.manage",
  "user.manage",
  "settings.manage",
] as const;

export type Action = (typeof ACTIONS)[number];

/** `own` means allowed only on files the user uploaded. */
type Rule = "allow" | "own" | "deny";

const MATRIX: Record<Action, Record<Role, Rule>> = {
  "file.view": { admin: "allow", editor: "allow", viewer: "allow" },
  "file.download": { admin: "allow", editor: "allow", viewer: "allow" },
  "file.search": { admin: "allow", editor: "allow", viewer: "allow" },
  "file.upload": { admin: "allow", editor: "allow", viewer: "deny" },
  "file.rename": { admin: "allow", editor: "own", viewer: "deny" },
  "file.move": { admin: "allow", editor: "own", viewer: "deny" },
  "file.delete": { admin: "allow", editor: "own", viewer: "deny" },
  "file.restore": { admin: "allow", editor: "own", viewer: "deny" },
  "file.retry": { admin: "allow", editor: "own", viewer: "deny" },
  "review.accept": { admin: "allow", editor: "allow", viewer: "deny" },
  "folder.manage": { admin: "allow", editor: "deny", viewer: "deny" },
  "user.manage": { admin: "allow", editor: "deny", viewer: "deny" },
  "settings.manage": { admin: "allow", editor: "deny", viewer: "deny" },
};

export class ForbiddenError extends Error {
  constructor(action: Action) {
    super(`Not allowed: ${action}`);
    this.name = "ForbiddenError";
  }
}

/** Owners act as admins in every company, with or without a membership row. */
export function effectiveRole(isOwner: boolean, membershipRole: Role | null): Role | null {
  return isOwner ? "admin" : membershipRole;
}

export function can(role: Role, action: Action, target: { ownsFile?: boolean } = {}): boolean {
  const rule = MATRIX[action][role];
  return rule === "allow" || (rule === "own" && target.ownsFile === true);
}

export function assertCan(role: Role, action: Action, target: { ownsFile?: boolean } = {}): void {
  if (!can(role, action, target)) throw new ForbiddenError(action);
}
