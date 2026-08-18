import { describe, it, expect } from "vitest";

import { scoreLead, compareByScore, type QueueSignals } from "./score";

const NOW = new Date("2026-08-18T12:00:00Z");

function signals(overrides: Partial<QueueSignals> = {}): QueueSignals {
  return {
    customerMessages: 0,
    hasUniversity: false,
    hasCourse: false,
    hasSpecialization: false,
    lastCustomerAt: null,
    lastAgentAt: null,
    ...overrides,
  };
}

describe("scoreLead", () => {
  it("scores a silent broadcast-only lead zero", () => {
    const s = scoreLead(signals(), NOW);
    expect(s.total).toBe(0);
    expect(s.isAwaitingReply).toBe(false);
  });

  it("gives 4 points per customer message", () => {
    expect(scoreLead(signals({ customerMessages: 3 }), NOW).engagement).toBe(12);
  });

  it("caps engagement at 10 messages", () => {
    expect(scoreLead(signals({ customerMessages: 26 }), NOW).engagement).toBe(40);
  });

  it("adds interest points per resolved step", () => {
    const s = scoreLead(
      signals({ hasUniversity: true, hasCourse: true, hasSpecialization: true }),
      NOW,
    );
    expect(s.interest).toBe(20);
    expect(scoreLead(signals({ hasUniversity: true }), NOW).interest).toBe(10);
  });

  it("marks a lead awaiting reply when the customer spoke last", () => {
    const s = scoreLead(
      signals({
        lastCustomerAt: new Date("2026-08-18T11:00:00Z"),
        lastAgentAt: new Date("2026-08-18T10:00:00Z"),
      }),
      NOW,
    );
    expect(s.isAwaitingReply).toBe(true);
    expect(s.awaitingReply).toBe(25);
  });

  it("marks a lead awaiting reply when no human ever replied", () => {
    const s = scoreLead(
      signals({ lastCustomerAt: new Date("2026-08-18T11:00:00Z") }),
      NOW,
    );
    expect(s.isAwaitingReply).toBe(true);
  });

  it("does not mark answered leads as awaiting", () => {
    const s = scoreLead(
      signals({
        lastCustomerAt: new Date("2026-08-18T10:00:00Z"),
        lastAgentAt: new Date("2026-08-18T11:00:00Z"),
      }),
      NOW,
    );
    expect(s.isAwaitingReply).toBe(false);
    expect(s.awaitingReply).toBe(0);
  });

  it("scores recency by the 24h and 72h buckets", () => {
    const at = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
    expect(scoreLead(signals({ lastCustomerAt: at(2) }), NOW).recency).toBe(15);
    expect(scoreLead(signals({ lastCustomerAt: at(48) }), NOW).recency).toBe(8);
    expect(scoreLead(signals({ lastCustomerAt: at(100) }), NOW).recency).toBe(0);
  });

  it("never exceeds 100", () => {
    const s = scoreLead(
      signals({
        customerMessages: 50,
        hasUniversity: true,
        hasCourse: true,
        hasSpecialization: true,
        lastCustomerAt: new Date("2026-08-18T11:59:00Z"),
      }),
      NOW,
    );
    expect(s.total).toBe(100);
  });

  it("ranks an engaged answered lead above a cold unanswered one", () => {
    // 8 messages + university + course, answered, fresh: 32+15+15 = 62.
    const engaged = scoreLead(
      signals({
        customerMessages: 8,
        hasUniversity: true,
        hasCourse: true,
        lastCustomerAt: new Date("2026-08-18T09:00:00Z"),
        lastAgentAt: new Date("2026-08-18T10:00:00Z"),
      }),
      NOW,
    );
    // 1 message, nothing resolved, unanswered, fresh: 4+25+15 = 44.
    const cold = scoreLead(
      signals({
        customerMessages: 1,
        lastCustomerAt: new Date("2026-08-18T09:00:00Z"),
      }),
      NOW,
    );
    expect(engaged.total).toBeGreaterThan(cold.total);
  });
});

describe("compareByScore", () => {
  const lead = (total: number, lastCustomerAt: string | null) => ({
    score: {
      total,
      engagement: 0,
      interest: 0,
      awaitingReply: 0,
      recency: 0,
      isAwaitingReply: false,
    },
    lastCustomerAt,
  });

  it("sorts by score descending", () => {
    const rows = [lead(10, null), lead(90, null), lead(50, null)];
    rows.sort(compareByScore);
    expect(rows.map((r) => r.score.total)).toEqual([90, 50, 10]);
  });

  it("breaks ties by freshest customer message, nulls last", () => {
    const rows = [
      lead(50, null),
      lead(50, "2026-08-18T08:00:00Z"),
      lead(50, "2026-08-18T11:00:00Z"),
    ];
    rows.sort(compareByScore);
    expect(rows.map((r) => r.lastCustomerAt)).toEqual([
      "2026-08-18T11:00:00Z",
      "2026-08-18T08:00:00Z",
      null,
    ]);
  });
});
