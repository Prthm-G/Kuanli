/**
 * Data access for the deterministic course sheet (KB-COURSEINFO-R4-40).
 *
 * Three invariants are enforced HERE, in SQL, rather than trusted to callers or
 * to the admin UI. Each one is a way a lead could be shown something wrong:
 *
 *   1. `status = 'approved'` — an unreviewed row must be UNREACHABLE, not merely
 *      unverified. This is the whole basis on which spot-checking the seeded
 *      data is survivable instead of reckless.
 *   2. `account_id` — `fee_templates` holds two accounts' worth of seeded rows
 *      (474 live, 2 x the seeds). An unscoped read returns duplicates, and
 *      duplicates of FEE data are exactly the thing not to get wrong.
 *   3. Coverage is reported, never guessed. A miss returns a typed `reason` so
 *      the caller can degrade to the LLM path deliberately, and so "why did this
 *      lead not get a sheet" is answerable after the fact.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { normKey } from './types';
import { loadFeeTemplates } from '@/lib/payments/queries';
import { INTERACTIVE_LIMITS } from '@/lib/whatsapp/meta-api';
import {
  composeCourseSheet,
  composeCourseSection,
  type CourseFeeRow,
  type CourseProse,
  type CourseSection,
} from './compose';

export interface CourseSheetParams {
  /**
   * When set, answer just this follow-up instead of the whole sheet. Driven by
   * the sheet's own menu buttons, so a second question stays deterministic.
   */
  section?: CourseSection;
  accountId: string;
  university: string;
  mode: 'distance' | 'online';
  /** The token from `sel:course:<uni>:<mode>:<token>`, e.g. "BA". */
  courseToken: string;
  /** Optional; any accepted spelling, resolved via program_aliases. */
  specialization?: string;
  lang: 'en' | 'hi';
}

/** Why no sheet was produced. Every miss has exactly one of these. */
export type CourseMissReason =
  | 'no_alias' // the (uni, mode, token) triple is not in the crosswalk at all
  | 'ambiguous_alias' // more than one programme matches and no specialization was given
  | 'no_approved_content'; // crosswalk resolves, but nothing is approved to say

export type CourseSheetResult =
  | {
      found: true;
      sheetText: string;
      menuRows: { id: string; title: string; description?: string }[];
      /** Repo-relative path for `Tool - Send Brochure`; null when none exists. */
      brochurePath: string | null;
      /**
       * Non-fatal problems worth surfacing. A sheet still went out, but
       * something about it is degraded - most importantly a dropped fee block,
       * which is silent to the lead and must not be silent to the operator.
       */
      warnings: string[];
    }
  | { found: false; reason: CourseMissReason };

interface AliasRow {
  fee_program: string;
  fee_specialization: string;
  canonical_specialization: string;
  brochure_path: string | null;
}

// Shared with the review panel so the two cannot diverge (the panel used a
// strict === while this file normalised - the exact two-places defect).
const norm = normKey;

/**
 * Resolve a bot course token to a single row on the fee spine.
 *
 * A token alone is often ambiguous: `MA` maps to nine specializations. When the
 * lead has not picked one we return `ambiguous_alias` rather than guessing,
 * because guessing here means quoting one subject's fees under another's name.
 */
async function resolveAlias(
  supabase: SupabaseClient,
  p: CourseSheetParams
): Promise<AliasRow | CourseMissReason> {
  const { data, error } = await supabase
    .from('program_aliases')
    .select(
      'fee_program, fee_specialization, canonical_specialization, brochure_path'
    )
    .eq('university', p.university)
    .eq('mode', p.mode)
    .eq('bot_course_token', p.courseToken);

  // A Supabase query returns {data, error}; it does not throw. Collapsing a
  // genuine fault (RLS regression, connection blip) into the same
  // business-as-usual 'no_alias' a legitimately unseeded course produces would
  // make an outage statistically invisible - most lookups legitimately miss.
  // The outcome stays the same so the bot still degrades gracefully; only the
  // operator gets told the difference.
  if (error) {
    console.error(
      '[course-info] program_aliases query failed',
      { university: p.university, mode: p.mode, courseToken: p.courseToken },
      error
    );
  }
  if (error || !data || data.length === 0) return 'no_alias';
  const rows = data as unknown as AliasRow[];

  if (rows.length === 1) return rows[0];

  if (p.specialization) {
    const want = norm(p.specialization);
    const hit = rows.find(
      (r) =>
        norm(r.fee_specialization) === want ||
        norm(r.canonical_specialization) === want
    );
    if (hit) return hit;
  }
  // A row with an EMPTY specialization is the general track, and that is the
  // right answer when the lead has picked a programme but not a subject. LPU
  // Distance MBA has one alongside twelve specializations, so tapping "MBA"
  // used to fall through to the LLM instead of describing the MBA.
  //
  // MA deliberately has no such row - all nine carry a subject - so it still
  // returns ambiguous, which is correct: the workflow then sends the
  // specialization list rather than guessing between Economics and History.
  const general = rows.find((r) => !r.fee_specialization);
  if (general) return general;

  // Several subjects share the token, none is general, and the lead has not
  // narrowed it. Refusing beats quoting one subject's fees under another's name.
  return 'ambiguous_alias';
}

export async function loadCourseSheet(
  supabase: SupabaseClient,
  p: CourseSheetParams
): Promise<CourseSheetResult> {
  const alias = await resolveAlias(supabase, p);
  if (typeof alias === 'string') return { found: false, reason: alias };

  const { data: contentRows, error: contentError } = await supabase
    .from('course_content')
    .select(
      'overview, duration, eligibility, credits, medium, careers, electives'
    )
    .eq('account_id', p.accountId)
    .eq('university', p.university)
    .eq('mode', p.mode)
    .eq('program', alias.fee_program)
    .eq('specialization', alias.fee_specialization)
    .eq('lang', p.lang)
    // Invariant 1. Never relax this: it is what keeps unreviewed content off
    // a real lead's phone.
    .eq('status', 'approved')
    .limit(1);

  if (contentError) {
    console.error(
      '[course-info] course_content query failed',
      { university: p.university, mode: p.mode, program: alias.fee_program },
      contentError
    );
  }
  if (contentError || !contentRows || contentRows.length === 0) {
    return { found: false, reason: 'no_approved_content' };
  }
  const prose = contentRows[0] as unknown as CourseProse;

  // Invariant 2: loadFeeTemplates already filters on account_id and active.
  // university/mode/program are pushed into the query - alias.fee_program IS
  // the fee-table spelling by construction (it comes off the fee spine via the
  // crosswalk), so exact-match filtering is safe and stops every course tap
  // pulling the entire fee table across the wire to be filtered in JS. The
  // norm() re-filter below stays as the belt to the braces.
  const allFees = await loadFeeTemplates(supabase, p.accountId, {
    university: p.university,
    mode: p.mode,
    program: alias.fee_program,
  });
  const fees: CourseFeeRow[] = allFees.filter(
    (f) =>
      f.university === p.university &&
      f.mode === p.mode &&
      norm(f.program) === norm(alias.fee_program) &&
      norm(f.specialization) === norm(alias.fee_specialization)
  );

  const composeInput = {
    program: alias.fee_program,
    specialization: alias.canonical_specialization || undefined,
    mode: p.mode,
    university: p.university,
    prose,
    fees,
    lang: p.lang,
  };

  // A follow-up tap answers one section from the same rows the sheet used, so a
  // second question costs no model call either. Built from the same
  // ComposeInput as the sheet rather than a second literal, so the two cannot
  // drift.
  const composed = p.section
    ? composeCourseSection(composeInput, p.section)
    : composeCourseSheet(composeInput);
  const { sheetText, menuRows, feesRendered, feeRowsDropped } = composed;

  // Invariant 3: report degradation instead of hiding it — but only about
  // things this reply actually tried to do.
  //
  // The eligibility and admission sections never render a fee block, so they
  // report feesRendered:false unconditionally. Running the fee warnings over
  // them turned every healthy tap of the two most-used follow-ups into a false
  // "fee block dropped" alert, which is worse than no alert: a real partial
  // drop becomes indistinguishable from routine traffic.
  const feeCheckApplies = !p.section || p.section === 'fees';
  const warnings: string[] = [];
  if (feeCheckApplies) {
    if (fees.length === 0) warnings.push('no_fee_rows');
    else if (!feesRendered)
      warnings.push('fee_block_dropped_arithmetic_mismatch');
    // A PARTIAL drop renders a fee block quietly missing a payment option; the
    // lead concludes that option is not offered.
    else if (feeRowsDropped > 0) warnings.push('fee_rows_partially_dropped');
  }
  // A section reply never sends a brochure, so its absence is not a defect here.
  if (!p.section && !alias.brochure_path) warnings.push('no_brochure');

  // Section replies go out as an interactive message, whose body cap (1024) is
  // far tighter than a plain text message. The prose columns have no length
  // constraint at any layer - no CHECK, no maxLength on the review textarea -
  // and the only cap that exists is a silent `.slice(0, 1024)` three layers
  // downstream in the n8n send node. That truncates mid-sentence with no log
  // and no sign to the reviewer, whose preview shows the untruncated text.
  // Dormant today (longest approved eligibility is ~239 chars) and a landmine.
  if (p.section && sheetText.length > INTERACTIVE_LIMITS.bodyMaxLength) {
    warnings.push('section_body_over_whatsapp_limit');
  }

  return {
    found: true,
    sheetText,
    menuRows,
    brochurePath: alias.brochure_path,
    warnings,
  };
}
