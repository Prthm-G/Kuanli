import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadCourseSheet, type CourseSheetParams } from './queries';

/**
 * Minimal in-memory stand-in for the Supabase query builder.
 *
 * Deliberately supports only what this module actually calls - select / eq /
 * order / limit and awaiting the chain. Filtering happens for real, so a test
 * that forgets an `.eq('status','approved')` in the module under test FAILS
 * here rather than passing against a mock that returns whatever it was told to.
 */
function fakeSupabase(tables: Record<string, Record<string, unknown>[]>) {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const builder = {
        select: () => builder,
        order: () => builder,
        eq: (col: string, val: unknown) => {
          rows = rows.filter((r) => r[col] === val);
          return builder;
        },
        limit: (n: number) =>
          Promise.resolve({ data: rows.slice(0, n), error: null }),
        then: (resolve: (v: { data: unknown; error: null }) => void) =>
          resolve({ data: rows, error: null }),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const ACCOUNT = 'acct-1';

const ALIAS_BA = {
  university: 'LPU',
  mode: 'distance',
  fee_program: 'BA',
  fee_specialization: '',
  canonical_specialization: '',
  brochure_path: 'LPU - Distance/B.A/Ba.pdf',
  bot_course_token: 'BA',
};

const ALIAS_MA_POLSCI = {
  university: 'LPU',
  mode: 'distance',
  fee_program: 'MA',
  fee_specialization: 'Polscience',
  canonical_specialization: 'Political Science',
  brochure_path: 'LPU - Distance/M.A/Ma_Polscience.pdf',
  bot_course_token: 'MA',
};

const ALIAS_MA_HISTORY = {
  ...ALIAS_MA_POLSCI,
  fee_specialization: 'History',
  canonical_specialization: 'History',
  brochure_path: 'LPU - Distance/M.A/Ma_History.pdf',
};

const CONTENT_BA_APPROVED = {
  account_id: ACCOUNT,
  university: 'LPU',
  mode: 'distance',
  program: 'BA',
  specialization: '',
  lang: 'en',
  status: 'approved',
  overview: 'LPU Distance BA is a UG-level distance-education programme.',
  duration: '3 years (maximum 6 years).',
  eligibility: '10+2 in any stream or equivalent.',
  credits: '108 credits across the full programme.',
  medium: 'English/Hindi/Punjabi.',
  careers: 'Teacher, Content Writer.',
  electives: 'History, Economics, Political Science.',
};

/** Raw `fee_templates` shape - loadFeeTemplates maps these to camelCase. */
const FEE_BA = {
  id: 'f1',
  account_id: ACCOUNT,
  university: 'LPU',
  mode: 'distance',
  program: 'BA',
  specialization: '',
  payment_option: 'per_semester',
  term_count: 6,
  programme_fee: 6000,
  exam_fee: 1500,
  total_fee: 45000,
  application_fee: 600,
  study_material_fee: 1200,
  list_discount_pct: null,
  currency: 'INR',
  variant: '',
  source: 'brochure:...',
  effective_from: '2026-07-01',
  active: true,
};

const baParams: CourseSheetParams = {
  accountId: ACCOUNT,
  university: 'LPU',
  mode: 'distance',
  courseToken: 'BA',
  lang: 'en',
};

describe('loadCourseSheet coverage', () => {
  it('returns no_alias for a token that is not in the crosswalk', async () => {
    const db = fakeSupabase({ program_aliases: [ALIAS_BA] });
    const r = await loadCourseSheet(db, { ...baParams, courseToken: 'PHD' });
    expect(r).toEqual({ found: false, reason: 'no_alias' });
  });

  it('returns ambiguous_alias when a token maps to several programmes and none was picked', async () => {
    // Guessing here would quote one subject's fees under another's name.
    const db = fakeSupabase({
      program_aliases: [ALIAS_MA_POLSCI, ALIAS_MA_HISTORY],
    });
    const r = await loadCourseSheet(db, { ...baParams, courseToken: 'MA' });
    expect(r).toEqual({ found: false, reason: 'ambiguous_alias' });
  });

  it('resolves an ambiguous token once the specialization is supplied', async () => {
    const db = fakeSupabase({
      program_aliases: [ALIAS_MA_POLSCI, ALIAS_MA_HISTORY],
      course_content: [
        { ...CONTENT_BA_APPROVED, program: 'MA', specialization: 'Polscience' },
      ],
      fee_templates: [
        { ...FEE_BA, program: 'MA', specialization: 'Polscience' },
      ],
    });
    const r = await loadCourseSheet(db, {
      ...baParams,
      courseToken: 'MA',
      // The canonical spelling, not the fee-table spelling - both must work.
      specialization: 'Political Science',
    });
    expect(r.found).toBe(true);
    if (r.found) expect(r.sheetText).toContain('MA (Political Science)');
  });

  it('NEVER serves a draft row', async () => {
    // The core safety property. Unreviewed content must be unreachable, not
    // merely unverified - it is the entire basis for spot-checking rather than
    // reviewing all 41 combinations.
    const db = fakeSupabase({
      program_aliases: [ALIAS_BA],
      course_content: [{ ...CONTENT_BA_APPROVED, status: 'draft' }],
      fee_templates: [FEE_BA],
    });
    const r = await loadCourseSheet(db, baParams);
    expect(r).toEqual({ found: false, reason: 'no_approved_content' });
  });

  it('does not leak another account’s content', async () => {
    const db = fakeSupabase({
      program_aliases: [ALIAS_BA],
      course_content: [{ ...CONTENT_BA_APPROVED, account_id: 'acct-2' }],
      fee_templates: [FEE_BA],
    });
    const r = await loadCourseSheet(db, baParams);
    expect(r).toEqual({ found: false, reason: 'no_approved_content' });
  });

  it('serves an approved row with fees and a brochure path', async () => {
    const db = fakeSupabase({
      program_aliases: [ALIAS_BA],
      course_content: [CONTENT_BA_APPROVED],
      fee_templates: [FEE_BA],
    });
    const r = await loadCourseSheet(db, baParams);
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.sheetText).toContain('3 years (maximum 6 years).');
    expect(r.sheetText).toContain('*Fees*');
    expect(r.brochurePath).toBe('LPU - Distance/B.A/Ba.pdf');
    expect(r.warnings).toEqual([]);
  });
});

describe('loadCourseSheet degradation warnings', () => {
  it('warns when the fee block was dropped for failing its own arithmetic', async () => {
    // The lead sees a sheet with no fees, which looks fine. The operator must
    // not also be in the dark about it.
    const db = fakeSupabase({
      program_aliases: [ALIAS_BA],
      course_content: [CONTENT_BA_APPROVED],
      fee_templates: [{ ...FEE_BA, total_fee: 1 }],
    });
    const r = await loadCourseSheet(db, baParams);
    expect(r.found).toBe(true);
    if (r.found) {
      expect(r.sheetText).not.toContain('*Fees*');
      expect(r.warnings).toContain('fee_block_dropped_arithmetic_mismatch');
    }
  });

  it('warns when there are no fee rows at all', async () => {
    const db = fakeSupabase({
      program_aliases: [ALIAS_BA],
      course_content: [CONTENT_BA_APPROVED],
      fee_templates: [],
    });
    const r = await loadCourseSheet(db, baParams);
    expect(r.found).toBe(true);
    if (r.found) expect(r.warnings).toContain('no_fee_rows');
  });

  it('warns when the crosswalk has no brochure for the programme', async () => {
    const db = fakeSupabase({
      program_aliases: [{ ...ALIAS_BA, brochure_path: null }],
      course_content: [CONTENT_BA_APPROVED],
      fee_templates: [FEE_BA],
    });
    const r = await loadCourseSheet(db, baParams);
    expect(r.found).toBe(true);
    if (r.found) expect(r.warnings).toContain('no_brochure');
  });
});

describe('general track resolution', () => {
  const ALIAS_MBA_GENERAL = {
    ...ALIAS_MA_POLSCI,
    fee_program: 'MBA',
    fee_specialization: '',
    canonical_specialization: '',
    bot_course_token: 'MBA',
    brochure_path: 'LPU - Distance/MBA/Mba_General.pdf',
  };
  const ALIAS_MBA_FINANCE = {
    ...ALIAS_MBA_GENERAL,
    fee_specialization: 'Finance',
    canonical_specialization: 'Finance',
    brochure_path: 'LPU - Distance/MBA/Mba_Finance.pdf',
  };

  it('prefers the general track when a token has one and no subject was picked', async () => {
    // LPU Distance MBA: a general track plus twelve specializations. Tapping
    // "MBA" should describe the MBA, not fall through to an out-of-quota LLM.
    const db = fakeSupabase({
      program_aliases: [ALIAS_MBA_GENERAL, ALIAS_MBA_FINANCE],
      course_content: [
        { ...CONTENT_BA_APPROVED, program: 'MBA', specialization: '' },
      ],
      fee_templates: [{ ...FEE_BA, program: 'MBA', specialization: '' }],
    });
    const r = await loadCourseSheet(db, { ...baParams, courseToken: 'MBA' });
    expect(r.found).toBe(true);
    if (r.found) expect(r.brochurePath).toContain('Mba_General.pdf');
  });

  it('still refuses when no general track exists', async () => {
    // MA has nine subjects and no general row. Guessing here would quote
    // Economics fees under a History heading.
    const db = fakeSupabase({
      program_aliases: [ALIAS_MA_POLSCI, ALIAS_MA_HISTORY],
    });
    const r = await loadCourseSheet(db, { ...baParams, courseToken: 'MA' });
    expect(r).toEqual({ found: false, reason: 'ambiguous_alias' });
  });
});

describe('section follow-ups', () => {
  const db = () =>
    fakeSupabase({
      program_aliases: [ALIAS_BA],
      course_content: [CONTENT_BA_APPROVED],
      fee_templates: [FEE_BA],
    });

  it('answers a section without a model call and keeps the counsellor route', async () => {
    const r = await loadCourseSheet(db(), { ...baParams, section: 'fees' });
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.sheetText).toContain('*Fees*');
    expect(r.menuRows.some((m) => m.id === 'ci:counsellor')).toBe(true);
  });

  it('applies the same approved-only gate to sections', async () => {
    // A section reply must not become a back door around the draft gate.
    const draftDb = fakeSupabase({
      program_aliases: [ALIAS_BA],
      course_content: [{ ...CONTENT_BA_APPROVED, status: 'draft' }],
      fee_templates: [FEE_BA],
    });
    const r = await loadCourseSheet(draftDb, { ...baParams, section: 'eligibility' });
    expect(r).toEqual({ found: false, reason: 'no_approved_content' });
  });

  it('still warns when a section renders no fees', async () => {
    const brokenDb = fakeSupabase({
      program_aliases: [ALIAS_BA],
      course_content: [CONTENT_BA_APPROVED],
      fee_templates: [{ ...FEE_BA, total_fee: 1 }],
    });
    const r = await loadCourseSheet(brokenDb, { ...baParams, section: 'fees' });
    expect(r.found).toBe(true);
    if (r.found) expect(r.warnings).toContain('fee_block_dropped_arithmetic_mismatch');
  });

  it('does NOT cry fee-block-dropped on sections that never show fees', async () => {
    // The regression this guards: eligibility and admission report
    // feesRendered:false by design, and running the fee warnings over them fired
    // a false alarm on every healthy tap of the two most-used follow-ups.
    for (const section of ['eligibility', 'admission'] as const) {
      const r = await loadCourseSheet(db(), { ...baParams, section });
      expect(r.found).toBe(true);
      if (r.found) expect(r.warnings).toEqual([]);
    }
  });

  it('warns when a section body would be silently truncated by WhatsApp', async () => {
    // The only cap today is a silent .slice(0,1024) in the n8n send node, which
    // cuts mid-sentence with no log while the reviewer's preview shows the full
    // text. Make it loud here instead.
    const longDb = fakeSupabase({
      program_aliases: [ALIAS_BA],
      course_content: [{ ...CONTENT_BA_APPROVED, eligibility: 'x'.repeat(1200) }],
      fee_templates: [FEE_BA],
    });
    const r = await loadCourseSheet(longDb, { ...baParams, section: 'eligibility' });
    expect(r.found).toBe(true);
    if (r.found) expect(r.warnings).toContain('section_body_over_whatsapp_limit');
  });

  it('is unaffected by an unknown course, same as the sheet', async () => {
    const r = await loadCourseSheet(db(), { ...baParams, courseToken: 'PHD', section: 'fees' });
    expect(r).toEqual({ found: false, reason: 'no_alias' });
  });
});

describe('no third state', () => {
  it('every outcome is either a served sheet or a typed miss reason', async () => {
    // QA's gate: a lead tapping any menu combination must land in exactly one
    // of two buckets. A silent blank sheet is the failure this forbids.
    const REASONS = ['no_alias', 'ambiguous_alias', 'no_approved_content'];
    const scenarios: CourseSheetParams[] = [
      baParams,
      { ...baParams, courseToken: 'PHD' },
      { ...baParams, courseToken: 'MA' },
      { ...baParams, mode: 'online' },
      { ...baParams, lang: 'hi' },
    ];
    const db = fakeSupabase({
      program_aliases: [ALIAS_BA, ALIAS_MA_POLSCI, ALIAS_MA_HISTORY],
      course_content: [CONTENT_BA_APPROVED],
      fee_templates: [FEE_BA],
    });

    for (const s of scenarios) {
      const r = await loadCourseSheet(db, s);
      if (r.found) {
        expect(r.sheetText.length).toBeGreaterThan(0);
        expect(Array.isArray(r.warnings)).toBe(true);
      } else {
        expect(REASONS).toContain(r.reason);
      }
    }
  });
});
