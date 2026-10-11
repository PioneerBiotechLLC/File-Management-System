import { describe, expect, it } from "vitest";
import { ACTIONS, ForbiddenError, ROLES, assertCan, can, effectiveRole, type Action } from "./permissions";

type Expected = "yes" | "own" | "no";

// The full matrix, written out independently of the implementation.
const EXPECTED: Record<Action, [admin: Expected, editor: Expected, viewer: Expected]> = {
  "file.view": ["yes", "yes", "yes"],
  "file.download": ["yes", "yes", "yes"],
  "file.search": ["yes", "yes", "yes"],
  "file.upload": ["yes", "yes", "no"],
  "file.rename": ["yes", "own", "no"],
  "file.move": ["yes", "own", "no"],
  "file.delete": ["yes", "own", "no"],
  "file.restore": ["yes", "own", "no"],
  "file.retry": ["yes", "own", "no"],
  "review.accept": ["yes", "yes", "no"],
  "folder.manage": ["yes", "no", "no"],
  "user.manage": ["yes", "no", "no"],
  "settings.manage": ["yes", "no", "no"],
};

describe("permission matrix", () => {
  it("covers every action", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ACTIONS].sort());
  });

  for (const action of ACTIONS) {
    ROLES.forEach((role, i) => {
      const expected = EXPECTED[action][i];
      it(`${role} ${action}: ${expected}`, () => {
        expect(can(role, action, { ownsFile: true })).toBe(expected !== "no");
        expect(can(role, action, { ownsFile: false })).toBe(expected === "yes");
        expect(can(role, action)).toBe(expected === "yes");
      });
    });
  }
});

describe("assertCan", () => {
  it("throws ForbiddenError when not allowed", () => {
    expect(() => assertCan("viewer", "file.upload")).toThrow(ForbiddenError);
    expect(() => assertCan("editor", "file.delete", { ownsFile: false })).toThrow(ForbiddenError);
  });

  it("passes when allowed", () => {
    expect(() => assertCan("editor", "file.delete", { ownsFile: true })).not.toThrow();
    expect(() => assertCan("admin", "user.manage")).not.toThrow();
  });
});

describe("effectiveRole", () => {
  it("makes owners admins everywhere", () => {
    expect(effectiveRole(true, null)).toBe("admin");
    expect(effectiveRole(true, "viewer")).toBe("admin");
  });

  it("uses the membership otherwise", () => {
    expect(effectiveRole(false, "editor")).toBe("editor");
    expect(effectiveRole(false, null)).toBeNull();
  });
});
