import { describe, it, expect } from "vitest";

import { renderEodEmail } from "./email";
import type { EodReport, EodRow } from "./types";

function row(over: Partial<EodRow> = {}): EodRow {
  return {
    conversationId: "c1",
    contactId: "k1",
    name: "Rahul",
    phone: "+919000000000",
    university: "LPU",
    mode: "Distance",
    course: "MBA",
    rollNumber: "LD-2608-0001",
    phoneNumberId: "110485318348695",
    status: "open",
    createdAt: "2026-08-18T09:00:00.000Z",
    ...over,
  };
}

const report = (rows: EodRow[]): EodReport => ({
  rows,
  summary: {
    total: rows.length,
    withUniversity: rows.filter((r) => r.university).length,
    withCourse: rows.filter((r) => r.course).length,
    enrolled: rows.filter((r) => r.rollNumber && !r.rollNumber.startsWith("LD-")).length,
  },
});

describe("renderEodEmail", () => {
  it("puts the count and range in the subject", () => {
    const { subject } = renderEodEmail(report([row(), row()]), "18 Aug 2026", null);
    expect(subject).toContain("18 Aug 2026");
    expect(subject).toContain("2 new conversations");
  });

  it("singularises a single conversation", () => {
    const { subject } = renderEodEmail(report([row()]), "18 Aug 2026", null);
    expect(subject).toContain("1 new conversation");
    expect(subject).not.toContain("conversations");
  });

  it("shows a placeholder roll number as a dash, not LD-…", () => {
    const { html, text } = renderEodEmail(report([row()]), "r", null);
    expect(html).not.toContain("LD-2608-0001");
    expect(text).not.toContain("LD-2608-0001");
  });

  it("shows a real roll number", () => {
    const { html } = renderEodEmail(report([row({ rollNumber: "DLPU26J0001" })]), "r", null);
    expect(html).toContain("DLPU26J0001");
  });

  it("renders unresolved fields as a dash rather than blank cells", () => {
    const { html } = renderEodEmail(
      report([row({ university: null, course: null, name: null })]),
      "r",
      null,
    );
    expect(html).toContain("—");
  });

  it("escapes user-controlled text so a lead name cannot inject markup", () => {
    const { html } = renderEodEmail(
      report([row({ name: '<img src=x onerror="alert(1)">' })]),
      "r",
      null,
    );
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("includes the Kuanli link only when a url is given", () => {
    expect(renderEodEmail(report([row()]), "r", null).html).not.toContain("Open in Kuanli");
    expect(
      renderEodEmail(report([row()]), "r", "https://crm.example.com/reports").html,
    ).toContain("Open in Kuanli");
  });

  it("handles an empty period without producing an empty table", () => {
    const { html, text } = renderEodEmail(report([]), "18 Aug 2026", null);
    expect(html).toContain("No new conversations");
    expect(text).toContain("New conversations : 0");
  });

  it("uses inline styles only, since Gmail strips style blocks", () => {
    const { html } = renderEodEmail(report([row()]), "r", null);
    expect(html).not.toContain("<style");
  });
});
