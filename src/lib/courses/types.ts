/**
 * Course content domain types (KB-COURSEINFO-R4-40).
 * Mirrors `course_content` from migration 062.
 */

export type CourseContentStatus = 'draft' | 'approved';
export type CourseLang = 'en' | 'hi';

export interface CourseContentRow {
  id: string;
  accountId: string;
  university: string;
  mode: 'distance' | 'online';
  program: string;
  specialization: string;
  lang: CourseLang;

  overview: string | null;
  duration: string | null;
  eligibility: string | null;
  credits: string | null;
  medium: string | null;
  careers: string | null;
  electives: string | null;

  status: CourseContentStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  /** When the ETL last wrote this row from the knowledge base. */
  kbSyncedAt: string | null;
  /**
   * Set when a field deliberately contradicts the knowledge base, with the
   * ruling that justifies it. Surfaced prominently in review: an override is
   * precisely the thing a reviewer must not skim past.
   */
  overrideNotes: string | null;
  updatedAt: string;
}

/** The prose fields, in the order they appear on the sheet. */
export const PROSE_FIELDS = [
  'overview',
  'duration',
  'eligibility',
  'credits',
  'medium',
  'electives',
  'careers',
] as const;

export type ProseField = (typeof PROSE_FIELDS)[number];

export const PROSE_LABEL: Record<ProseField, string> = {
  overview: 'Overview',
  duration: 'Duration',
  eligibility: 'Eligibility',
  credits: 'Credits',
  medium: 'Medium of instruction',
  electives: 'Electives',
  careers: 'Careers',
};

/** Human label for a row, e.g. "MA (Political Science) - LPU Distance". */
/**
 * The matching key used everywhere a course string from one system is compared
 * with a course string from another: upper-case, strip every non-alphanumeric.
 * There are five spellings of some specializations across five systems;
 * program_aliases reconciles them, and THIS is the equality those comparisons
 * run under.
 *
 * ONE definition on purpose. The health check's SQL carries the equivalent
 * regexp_replace(UPPER(x),'[^A-Z0-9]','','g') - if this changes, that changes.
 */
export const normKey = (s: string | null | undefined): string =>
  String(s ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

export function courseLabel(r: {
  program: string;
  specialization: string;
  university: string;
  mode: string;
}): string {
  const spec = r.specialization ? ` (${r.specialization})` : '';
  const mode = r.mode === 'distance' ? 'Distance' : 'Online';
  return `${r.program}${spec} - ${r.university} ${mode}`;
}
