import { describe, it, expect } from "vitest";

import { resolveRange, describeRange } from "./period";

/** 18 Aug 2026, 14:37 local. Mid-month and mid-afternoon so day boundaries
 *  and month boundaries are both non-trivial. */
const NOW = new Date(2026, 7, 18, 14, 37, 12);

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;

describe("resolveRange", () => {
  it("day covers midnight to next midnight, not 23:59:59", () => {
    const { start, end } = resolveRange("day", NOW);
    expect(iso(start)).toBe("2026-08-18 00:00");
    expect(iso(end)).toBe("2026-08-19 00:00");
  });

  it("week is the trailing 7 days including today", () => {
    const { start, end } = resolveRange("week", NOW);
    expect(iso(start)).toBe("2026-08-12 00:00");
    expect(iso(end)).toBe("2026-08-19 00:00");
    // Exactly 7 days wide.
    expect((end.getTime() - start.getTime()) / 86400000).toBe(7);
  });

  it("month is the calendar month to date", () => {
    const { start, end } = resolveRange("month", NOW);
    expect(iso(start)).toBe("2026-08-01 00:00");
    expect(iso(end)).toBe("2026-08-19 00:00");
  });

  it("ranges are half-open so a conversation cannot land in two tabs", () => {
    const day = resolveRange("day", NOW);
    const justBeforeMidnight = new Date(2026, 7, 18, 23, 59, 59, 999);
    const exactlyMidnight = new Date(2026, 7, 19, 0, 0, 0, 0);
    expect(justBeforeMidnight >= day.start && justBeforeMidnight < day.end).toBe(true);
    expect(exactlyMidnight < day.end).toBe(false);
  });

  it("week crosses a month boundary correctly", () => {
    const { start, end } = resolveRange("week", new Date(2026, 8, 2, 9, 0));
    expect(iso(start)).toBe("2026-08-27 00:00");
    expect(iso(end)).toBe("2026-09-03 00:00");
  });

  it("month on the 1st still covers that day", () => {
    const { start, end } = resolveRange("month", new Date(2026, 8, 1, 0, 30));
    expect(iso(start)).toBe("2026-09-01 00:00");
    expect(iso(end)).toBe("2026-09-02 00:00");
  });

  it("handles a leap day without shifting", () => {
    const { start, end } = resolveRange("day", new Date(2028, 1, 29, 12, 0));
    expect(iso(start)).toBe("2028-02-29 00:00");
    expect(iso(end)).toBe("2028-03-01 00:00");
  });
});

describe("describeRange", () => {
  it("collapses a single-day range to one date", () => {
    expect(describeRange(resolveRange("day", NOW))).not.toContain("–");
  });

  it("shows the last included day, not the exclusive end", () => {
    const label = describeRange(resolveRange("week", NOW));
    expect(label).toContain("–");
    // Asserted against the same formatter rather than a literal, so the test
    // does not depend on the runner's locale.
    const fmt = (d: Date) =>
      d.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
    expect(label.endsWith(fmt(new Date(2026, 7, 18)))).toBe(true);
    // 19 Aug is the exclusive end and must not appear.
    expect(label).not.toContain(fmt(new Date(2026, 7, 19)));
  });
});
