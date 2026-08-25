/**
 * Admission register (Excel-retirement roadmap, step 2): the per-university,
 * per-intake master list of enrolled students the office used to keep as a
 * spreadsheet register. A read model over contacts — a contact is "in the
 * register" once enrollment has set `university` (migration 026). Course and
 * mode come from the newest conversation interest mirror, the same signal the
 * EOD report uses.
 */

import type { ContactSource } from '@/types';
import { sourceLabel } from '@/lib/contacts/source';

/** Shape returned by the contacts query with embedded conversations. */
export interface RegisterRaw {
  id: string;
  name: string | null;
  phone: string | null;
  roll_number: string | null;
  university_roll_number: string | null;
  university: string | null;
  intake_year: string | null;
  intake_session: string | null;
  source: ContactSource | null;
  source_detail: string | null;
  created_at: string;
  conversations?: Array<{
    interest_course: string | null;
    interest_mode: string | null;
    interest_updated_at: string | null;
  }> | null;
}

export interface RegisterRow {
  contactId: string;
  name: string | null;
  phone: string | null;
  dcid: string | null;
  universityRollNumber: string | null;
  university: string;
  intake: string;
  course: string | null;
  mode: string | null;
  source: ContactSource;
  sourceDetail: string | null;
  createdAt: string;
}

/** "26 Jul" style intake label from the stored year/session pair. */
export function intakeLabel(
  year: string | null,
  session: string | null
): string {
  if (!year && !session) return '';
  return [year ? `20${year}` : '', session ?? ''].filter(Boolean).join(' ');
}

export function toRegisterRows(raw: RegisterRaw[]): RegisterRow[] {
  return raw
    .filter((r) => !!r.university)
    .map((r) => {
      // Newest interest wins — same rule as the lead_queue RPC's LATERAL.
      const interest = (r.conversations ?? [])
        .filter((c) => c.interest_updated_at)
        .sort((a, b) =>
          (b.interest_updated_at ?? '').localeCompare(
            a.interest_updated_at ?? ''
          )
        )[0];
      return {
        contactId: r.id,
        name: r.name,
        phone: r.phone,
        dcid: r.roll_number,
        universityRollNumber: r.university_roll_number,
        university: r.university!,
        intake: intakeLabel(r.intake_year, r.intake_session),
        course: interest?.interest_course ?? null,
        mode: interest?.interest_mode ?? null,
        source: r.source ?? 'organic',
        sourceDetail: r.source_detail,
        createdAt: r.created_at,
      };
    });
}

const esc = (v: string | null) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export function registerCsv(rows: RegisterRow[]): string {
  const head = [
    'DCId',
    'University roll no',
    'Name',
    'Phone',
    'University',
    'Intake',
    'Course',
    'Mode',
    'Source',
    'Referred by',
    'Added',
  ];
  const lines = rows.map((r) =>
    [
      r.dcid,
      r.universityRollNumber,
      r.name,
      r.phone,
      r.university,
      r.intake,
      r.course,
      r.mode,
      sourceLabel(r.source),
      r.sourceDetail,
      new Date(r.createdAt).toLocaleDateString(),
    ]
      .map(esc)
      .join(',')
  );
  return [head.map(esc).join(','), ...lines].join('\n');
}
