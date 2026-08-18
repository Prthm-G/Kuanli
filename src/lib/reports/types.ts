import type { EodPeriod } from "./period";

export type { EodPeriod };

/** One conversation started in the reporting window. */
export interface EodRow {
  conversationId: string;
  contactId: string | null;
  name: string | null;
  phone: string | null;
  /** Bot-inferred, mirrored from n8n by migration 038. Null until the lead picks. */
  university: string | null;
  mode: string | null;
  course: string | null;
  /** Trigger-assigned. `LD-…` means still a placeholder, not yet enrolled. */
  rollNumber: string | null;
  /** The business number the lead wrote to. */
  phoneNumberId: string | null;
  status: string | null;
  createdAt: string;
}

export interface EodSummary {
  total: number;
  withUniversity: number;
  withCourse: number;
  enrolled: number;
}

export interface EodReport {
  rows: EodRow[];
  summary: EodSummary;
}

/** True when the roll number is still the auto-assigned lead placeholder. */
export function isPlaceholderRoll(roll: string | null): boolean {
  return !roll || roll.startsWith("LD-");
}

export function summarise(rows: EodRow[]): EodSummary {
  return {
    total: rows.length,
    withUniversity: rows.filter((r) => !!r.university).length,
    withCourse: rows.filter((r) => !!r.course).length,
    enrolled: rows.filter((r) => !isPlaceholderRoll(r.rollNumber)).length,
  };
}
