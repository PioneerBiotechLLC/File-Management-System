import { describe, expect, it } from "vitest";
import { startOfDay, startOfMonth } from "./time";

describe("startOfDay", () => {
  it("uses the company's local day in Dubai (UTC+4)", () => {
    expect(startOfDay(new Date("2026-10-11T02:00:00Z"), "Asia/Dubai").toISOString()).toBe("2026-10-10T20:00:00.000Z");
    expect(startOfDay(new Date("2026-10-10T21:00:00Z"), "Asia/Dubai").toISOString()).toBe("2026-10-10T20:00:00.000Z");
    expect(startOfDay(new Date("2026-10-10T19:59:59Z"), "Asia/Dubai").toISOString()).toBe("2026-10-09T20:00:00.000Z");
  });

  it("handles UTC", () => {
    expect(startOfDay(new Date("2026-03-01T23:59:59Z"), "UTC").toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("handles daylight saving days", () => {
    // New York moves from UTC-5 to UTC-4 at 02:00 local on 8 March 2026; midnight is still UTC-5.
    expect(startOfDay(new Date("2026-03-08T15:00:00Z"), "America/New_York").toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(startOfDay(new Date("2026-03-09T15:00:00Z"), "America/New_York").toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });
});

describe("startOfMonth", () => {
  it("uses the company's local month", () => {
    expect(startOfMonth(new Date("2026-10-31T21:00:00Z"), "Asia/Dubai").toISOString()).toBe("2026-10-31T20:00:00.000Z");
    expect(startOfMonth(new Date("2026-10-31T19:00:00Z"), "Asia/Dubai").toISOString()).toBe("2026-09-30T20:00:00.000Z");
    expect(startOfMonth(new Date("2026-02-15T12:00:00Z"), "UTC").toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });
});
