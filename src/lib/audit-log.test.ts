import { describe, expect, it } from "vitest";
import { describeEntry, type LogPart } from "./audit-log";

const lookups = {
  files: new Map([
    ["f1", { name: "Invoice 42.pdf", deleted: false }],
    ["f2", { name: "Old quote.pdf", deleted: true }],
  ]),
  folders: new Map([
    ["sales", "Sales / Quotations"],
    ["finance", "Finance / Invoices Issued"],
  ]),
  users: new Map([["u9", "vic@x.com"]]),
};

/** Flattens the parts to a sentence, marking links with [brackets]. */
function sentence(action: string, targetId: string, before?: object, after?: object, targetType = "file"): string {
  return describeEntry({ action, targetType, targetId, before: before ?? null, after: after ?? null }, lookups)
    .map((p: LogPart) => (typeof p === "string" ? p : "folder" in p ? p.folder : p.link ? `[${p.name}]` : p.name))
    .join("");
}

describe("describeEntry", () => {
  it("describes sign-ins and refusals", () => {
    expect(sentence("auth.signin", "u1", undefined, undefined, "user")).toBe("Signed in");
    expect(sentence("auth.signout", "u1", undefined, undefined, "user")).toBe("Signed out");
    expect(sentence("auth.refused", "x@y.com", undefined, { reason: "not_listed" }, "user")).toBe("Was refused sign-in (not on the list of users)");
  });

  it("names files and folders, linking only files that still exist", () => {
    expect(sentence("file.upload", "f1", undefined, { name: "Invoice 42.pdf", folderId: "finance" })).toBe("Uploaded [Invoice 42.pdf] to Finance / Invoices Issued");
    expect(sentence("file.upload", "f1", undefined, { folderId: null })).toBe("Uploaded [Invoice 42.pdf] (waiting in Review)");
    expect(sentence("file.move", "f1", { folderId: "sales" }, { folderId: "finance" })).toBe("Moved [Invoice 42.pdf] from Sales / Quotations to Finance / Invoices Issued");
    expect(sentence("file.move", "f1", { folderId: null }, { folderId: "sales" })).toBe("Moved [Invoice 42.pdf] from Review to Sales / Quotations");
    expect(sentence("file.delete", "f2", { name: "Old quote.pdf" })).toBe("Deleted Old quote.pdf");
    expect(sentence("file.delete", "gone", { name: "Purged.pdf" })).toBe("Deleted Purged.pdf");
    expect(sentence("file.restore", "gone")).toBe("Restored a file that has since been removed");
  });

  it("describes renames, edits, versions and downloads", () => {
    expect(sentence("file.rename", "f1", { name: "scan001.pdf" }, { name: "Invoice 42.pdf" })).toBe("Renamed “scan001.pdf” to [Invoice 42.pdf]");
    expect(sentence("file.details", "f1", { title: null, tags: [] }, { title: "Invoice", tags: ["acme"] })).toBe("Edited the title, tags of [Invoice 42.pdf]");
    expect(sentence("file.version", "f1", undefined, { versionNo: 3 })).toBe("Uploaded version 3 of [Invoice 42.pdf]");
    expect(sentence("file.download", "f1", undefined, { versionNo: 2, current: true })).toBe("Downloaded [Invoice 42.pdf]");
    expect(sentence("file.preview", "f1", undefined, { versionNo: 1, current: false })).toBe("Viewed version 1 of [Invoice 42.pdf]");
  });

  it("describes folder and people changes", () => {
    expect(sentence("folder.grant", "sales", undefined, { user: "sara@x.com", canWrite: true }, "folder")).toBe("Gave sara@x.com read and write access to Sales / Quotations");
    expect(sentence("folder.revoke", "sales", { user: "sara@x.com" }, undefined, "folder")).toBe("Removed sara@x.com's access to Sales / Quotations");
    expect(sentence("folder.update", "sales", { name: "Quotes" }, { name: "Quotations" }, "folder")).toBe("Renamed the folder “Quotes” to Sales / Quotations");
    expect(sentence("membership.role", "u1", { email: "sara@x.com", role: "editor" }, { email: "sara@x.com", role: "admin" }, "user")).toBe(
      "Changed sara@x.com from editor to admin",
    );
    expect(sentence("user.reactivate", "u9", undefined, undefined, "user")).toBe("Reactivated vic@x.com");
    expect(sentence("something.new", "x")).toBe("something.new");
  });

  it("describes AI reading, summaries and limits", () => {
    expect(sentence("file.analyze", "f1", undefined, { outcome: "read", costUsd: 0.0213 })).toBe("Had the AI read [Invoice 42.pdf] ($0.021)");
    expect(sentence("file.analyze", "f1", undefined, { outcome: "read", costUsd: 0.5 })).toBe("Had the AI read [Invoice 42.pdf] ($0.50)");
    expect(sentence("file.analyze", "f1", undefined, { outcome: "not_read", reason: "Handwritten" })).toBe("The AI did not read [Invoice 42.pdf]: Handwritten");
    expect(sentence("file.analyze", "f1", undefined, { outcome: "failed", reason: "overloaded" })).toBe("AI reading of [Invoice 42.pdf] failed: overloaded");
    expect(sentence("file.summary", "f1", undefined, { source: "ai", edited: false })).toBe("Confirmed the AI summary of [Invoice 42.pdf]");
    expect(sentence("file.summary", "f1", undefined, { source: "ai", edited: true })).toBe("Edited and confirmed the AI summary of [Invoice 42.pdf]");
    expect(sentence("file.summary", "f1", undefined, { source: "manual" })).toBe("Wrote the summary of [Invoice 42.pdf]");
    expect(sentence("ai.limits", "org", undefined, { dailyUsd: 5, monthlyUsd: null }, "organization")).toBe("Set the company's AI limits to $5.00 a day and the default a month");
    expect(sentence("ai.limits", "u1", undefined, { email: "sara@x.com", dailyUsd: 1, monthlyUsd: 20 }, "user")).toBe("Set sara@x.com's AI limits to $1.00 a day and $20.00 a month");
  });

  it("describes searches", () => {
    expect(sentence("search.instant", "u1", undefined, { query: "insulin gulf", hits: 1 }, "search")).toBe("Searched for “insulin gulf” (1 result)");
    expect(sentence("search.instant", "u1", undefined, { query: "insulin", hits: 0, filters: { folderId: "sales", docType: "coa", dateFrom: "2026-01-01" } }, "search")).toBe(
      "Searched for “insulin” in Sales / Quotations, type Certificate of analysis, from 2026-01-01 (0 results)",
    );
    expect(sentence("search.ask", "u1", undefined, { question: "last spring's quotation", files: ["a", "b"] }, "search")).toBe("Asked the AI “last spring's quotation” (2 files found)");
    expect(sentence("search.ask", "u1", undefined, { question: "x", error: "cap reached" }, "search")).toBe("Asked the AI “x” (failed: cap reached)");
  });
});
