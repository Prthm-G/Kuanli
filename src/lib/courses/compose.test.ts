import { describe, expect, it } from 'vitest';
import { INTERACTIVE_LIMITS } from '@/lib/whatsapp/meta-api';
import {
  composeCourseSheet,
  composeCourseSection,
  feeRowReconciles,
  COURSE_SECTIONS,
  type CourseFeeRow,
} from './compose';

/**
 * Real LPU Distance BA data, pulled 2026-08-20 from
 * `n8n_database.lpu_distance_university_knowledge` (prose) and
 * `supabase.fee_templates` (fees). Kept verbatim so the test fails if the
 * composer starts mangling actual production content.
 */
const BA_PROSE = {
  overview:
    "LPU Distance BA (Bachelor of Arts, programme code 4120-S) is a UG-level distance-education programme delivered through LPU's Centre for Distance and Online Education.",
  duration: 'Minimum 2 years, maximum 4 years.',
  eligibility: '10+2 in any stream or equivalent.',
  credits: '108 credits across the full programme.',
  medium: 'English/Hindi/Punjabi.',
  careers: 'Teacher, Content Writer, Government Exam Aspirant, Social Worker.',
  electives:
    'From Basket 1: History, Economics, Political Science, Sociology, Computer Applications, Management. From Basket 2 (language electives): Elective English, Elective Hindi, Elective Punjabi.',
};

const BA_FEES: CourseFeeRow[] = [
  {
    paymentOption: 'per_semester',
    termCount: 6,
    programmeFee: 6000,
    examFee: 1500,
    totalFee: 45000,
    applicationFee: 600,
    studyMaterialFee: 1200,
    currency: 'INR',
  },
  {
    paymentOption: 'annual',
    termCount: 3,
    programmeFee: 11000,
    examFee: 3000,
    totalFee: 42000,
    applicationFee: 600,
    studyMaterialFee: 1200,
    currency: 'INR',
  },
  {
    paymentOption: 'lump_sum',
    termCount: 1,
    programmeFee: 30000,
    examFee: 9000,
    totalFee: 39000,
    applicationFee: 600,
    studyMaterialFee: 1200,
    currency: 'INR',
  },
];

const baInput = {
  program: 'BA',
  mode: 'distance' as const,
  university: 'LPU',
  prose: BA_PROSE,
  fees: BA_FEES,
  lang: 'en' as const,
};

describe('feeRowReconciles', () => {
  it('accepts every seeded LPU Distance BA row', () => {
    for (const row of BA_FEES) expect(feeRowReconciles(row)).toBe(true);
  });

  it('rejects a row whose total does not match its own arithmetic', () => {
    // The failure this guards: someone edits programmeFee and not totalFee.
    expect(feeRowReconciles({ ...BA_FEES[0], programmeFee: 9999 })).toBe(false);
  });

  it('rejects a row with a missing total', () => {
    expect(feeRowReconciles({ ...BA_FEES[0], totalFee: null })).toBe(false);
  });

  // Real Amity rows from fee_templates. 056's header records the structure:
  // "Amity's BA splits 115,000 as 19,200 x5 then 19,000". Exact-equality
  // rejected 248 active rows, which would have stripped both instalment
  // options off every Amity sheet and quoted lump-sum only.
  it('accepts a final instalment smaller than the others', () => {
    expect(
      feeRowReconciles({
        paymentOption: 'per_semester',
        termCount: 6,
        programmeFee: 19200,
        examFee: 0,
        totalFee: 115000, // 19,200 x5 = 96,000, final term 19,000
        applicationFee: null,
        studyMaterialFee: null,
        currency: 'INR',
      })
    ).toBe(true);
  });

  it('accepts the annual Amity row that missed by ten rupees', () => {
    expect(
      feeRowReconciles({
        paymentOption: 'annual',
        termCount: 3,
        programmeFee: 36420,
        examFee: 0,
        totalFee: 109250, // naive computed 109,260
        applicationFee: null,
        studyMaterialFee: null,
        currency: 'INR',
      })
    ).toBe(true);
  });

  // The loosening must not weaken the check. A final instalment LARGER than a
  // normal one is not a pricing structure, it is an inflated total.
  it('still rejects a total larger than the instalments can account for', () => {
    expect(
      feeRowReconciles({ ...BA_FEES[0], totalFee: 90000 })
    ).toBe(false);
  });

  it('still rejects a total smaller than the earlier instalments alone', () => {
    // 6000+1500 = 7500 per term; five of them is already 37,500.
    expect(
      feeRowReconciles({ ...BA_FEES[0], totalFee: 30000 })
    ).toBe(false);
  });

  it('rejects a zero per-term fee rather than dividing by nothing', () => {
    expect(
      feeRowReconciles({ ...BA_FEES[0], programmeFee: 0, examFee: 0 })
    ).toBe(false);
  });

  it('accepts a lump sum, where the whole total is the only instalment', () => {
    expect(feeRowReconciles(BA_FEES[2])).toBe(true);
  });
});

describe('composeCourseSheet', () => {
  it('renders the LPU Distance BA sheet', () => {
    const { sheetText } = composeCourseSheet(baInput);

    expect(sheetText).toContain('*BA - LPU Distance*');
    expect(sheetText).toContain('programme code 4120-S');
    expect(sheetText).toContain('Minimum 2 years, maximum 4 years.');
    expect(sheetText).toContain('10+2 in any stream or equivalent.');
    // All three payment options, each with its whole-programme total.
    expect(sheetText).toContain('per semester x 6');
    expect(sheetText).toContain('per year x 3');
    expect(sheetText).toContain('one-time');
  });

  it('never emits a URL or a double asterisk', () => {
    // Both would make `Deterministic Stage Guard` discard the ENTIRE reply and
    // send the canned fallback instead, silently losing the sheet.
    const { sheetText } = composeCourseSheet({
      ...baInput,
      prose: { ...BA_PROSE, overview: 'See **https://lpude.in** for details.' },
    });
    expect(sheetText).not.toMatch(/https?:\/\//);
    expect(sheetText).not.toMatch(/\*\*/);
  });

  it('omits a fee block entirely when no row reconciles', () => {
    const { sheetText } = composeCourseSheet({
      ...baInput,
      fees: [{ ...BA_FEES[0], totalFee: 1 }],
    });
    // Better to say nothing about fees than to quote a number that is wrong.
    expect(sheetText).not.toContain('*Fees*');
    expect(sheetText).toContain('10+2 in any stream'); // rest still renders
  });

  it('renders Hindi labels when lang is hi', () => {
    const { sheetText, menuRows } = composeCourseSheet({
      ...baInput,
      lang: 'hi',
    });
    expect(sheetText).toContain('अवधि');
    expect(sheetText).toContain('योग्यता');
    expect(menuRows.some((r) => r.title === 'काउंसलर से बात करें')).toBe(true);
  });

  it('includes the specialization in the title when present', () => {
    const { sheetText } = composeCourseSheet({
      ...baInput,
      program: 'MA',
      specialization: 'Political Science',
    });
    expect(sheetText).toContain('*MA (Political Science) - LPU Distance*');
  });

  it('reports a PARTIAL fee drop instead of hiding it', () => {
    // The dangerous middle case, and the one that was invisible before: one
    // payment option is rejected, the block still renders, and the lead simply
    // concludes that option is not offered. Neither the sheet nor the old
    // warning logic said anything, because the old check only looked for the
    // block being absent entirely.
    const [good, bad, alsoGood] = BA_FEES;
    const r = composeCourseSheet({
      ...baInput,
      fees: [good, { ...bad, totalFee: 1 }, alsoGood],
    });
    expect(r.feesRendered).toBe(true);
    expect(r.feeRowsDropped).toBe(1);
    expect(r.sheetText).toContain('*Fees*');
    // The surviving options are still shown; only the broken one is absent.
    expect(r.sheetText).toContain('per semester x 6');
    expect(r.sheetText).not.toContain('per year x 3');
  });

  it('reports feesRendered false when every row is rejected', () => {
    const r = composeCourseSheet({
      ...baInput,
      fees: BA_FEES.map((f) => ({ ...f, totalFee: 1 })),
    });
    expect(r.feesRendered).toBe(false);
    expect(r.feeRowsDropped).toBe(BA_FEES.length);
  });

  it('rejects a row with no term count, which the fee form must also refuse', () => {
    // feeRowReconciles is now the single predicate the save dialog calls too,
    // so a row the form accepts can no longer be one the bot silently drops.
    expect(feeRowReconciles({ ...BA_FEES[0], termCount: null })).toBe(false);
    expect(feeRowReconciles({ ...BA_FEES[0], programmeFee: null })).toBe(false);
  });

  it('always offers a counsellor as the last resort', () => {
    // With no paid LLM quota the escalation tier is unreliable, so a human
    // hand-off must always be one tap away.
    const { menuRows } = composeCourseSheet(baInput);
    expect(menuRows.at(-1)?.id).toBe('ci:counsellor');
  });
});

describe('composeCourseSection', () => {
  it('every section always offers a counsellor', () => {
    // The invariant the sheet is tested for, extended to follow-ups. The first
    // version returned an empty menu, so a lead who tapped "Fee details" got
    // fees and no route to a human — with the AI out of quota, the worst place
    // to strand someone.
    for (const section of COURSE_SECTIONS) {
      const r = composeCourseSection(baInput, section);
      expect(r.menuRows.some((m) => m.id === 'ci:counsellor')).toBe(true);
    }
  });

  it('never emits a URL or a double asterisk, in any section', () => {
    // Either would make the n8n sanitiser discard the whole reply.
    for (const section of COURSE_SECTIONS) {
      const r = composeCourseSection(
        {
          ...baInput,
          prose: { ...BA_PROSE, eligibility: 'See **https://lpude.in**' },
        },
        section
      );
      expect(r.sheetText).not.toMatch(/https?:\/\//);
      expect(r.sheetText).not.toMatch(/\*\*/);
    }
  });

  it('fees section quotes every payment option', () => {
    const r = composeCourseSection(baInput, 'fees');
    expect(r.feesRendered).toBe(true);
    expect(r.sheetText).toContain('per semester x 6');
    expect(r.sheetText).toContain('per year x 3');
    expect(r.sheetText).toContain('one-time');
  });

  it('fees section offers a human rather than inventing a number', () => {
    const r = composeCourseSection(
      { ...baInput, fees: BA_FEES.map((f) => ({ ...f, totalFee: 1 })) },
      'fees'
    );
    expect(r.feesRendered).toBe(false);
    expect(r.sheetText).not.toMatch(/₹/);
    expect(r.sheetText.toLowerCase()).toContain('counsellor');
  });

  it('eligibility section carries duration and credits', () => {
    const r = composeCourseSection(baInput, 'eligibility');
    expect(r.sheetText).toContain('10+2 in any stream');
    expect(r.sheetText).toContain('Minimum 2 years');
    expect(r.sheetText).toContain('108 credits');
  });

  it('admission section states the application fee once, as a heading', () => {
    const r = composeCourseSection(baInput, 'admission');
    expect(r.sheetText).toContain('*Application fee:*');
    expect(r.sheetText).toContain('₹600');
  });

  it('renders Hindi boilerplate, not English sentences under Hindi labels', () => {
    // The section text was hardcoded English at first, which would have shipped
    // a half-translated reply the moment Hindi content is seeded.
    for (const section of COURSE_SECTIONS) {
      const r = composeCourseSection({ ...baInput, lang: 'hi' }, section);
      expect(r.sheetText).toMatch(/[\u0900-\u097F]/);
    }
  });

  it('survives a course with no prose at all', () => {
    for (const section of COURSE_SECTIONS) {
      const r = composeCourseSection({ ...baInput, prose: {} }, section);
      expect(r.sheetText.length).toBeGreaterThan(0);
      expect(r.menuRows.length).toBeGreaterThan(0);
    }
  });
});

describe('WhatsApp interactive limits', () => {
  /**
   * Meta REJECTS a message whose button title or list row exceeds its cap — the
   * lead simply receives nothing, and the failure is an API error in a log.
   *
   * These labels currently sit right on the edge: "Talk to a counsellor" is
   * exactly 20 characters against a 20 cap, and "Eligibility & documents" is 23
   * against 24. A single reworded label would break delivery silently, so pin it.
   */
  it('every sheet menu title fits a WhatsApp list row', () => {
    for (const lang of ['en', 'hi'] as const) {
      const { menuRows } = composeCourseSheet({ ...baInput, lang });
      expect(menuRows.length).toBeLessThanOrEqual(
        INTERACTIVE_LIMITS.maxListRowsTotal
      );
      for (const row of menuRows) {
        expect(
          row.title.length,
          `list row "${row.title}" (${lang}) is ${row.title.length} chars`
        ).toBeLessThanOrEqual(INTERACTIVE_LIMITS.listRowTitleMaxLength);
      }
    }
  });

  it('every section menu title fits a WhatsApp reply BUTTON, which is stricter', () => {
    for (const lang of ['en', 'hi'] as const) {
      for (const section of COURSE_SECTIONS) {
        const { menuRows } = composeCourseSection(
          { ...baInput, lang },
          section
        );
        expect(menuRows.length).toBeLessThanOrEqual(
          INTERACTIVE_LIMITS.maxButtons
        );
        for (const row of menuRows) {
          expect(
            row.title.length,
            `button "${row.title}" (${lang}, ${section}) is ${row.title.length} chars`
          ).toBeLessThanOrEqual(INTERACTIVE_LIMITS.buttonTitleMaxLength);
        }
      }
    }
  });

  it('a section body fits an interactive message body', () => {
    // Sections are sent as interactive buttons, whose body cap (1024) is far
    // tighter than a plain text message (4096).
    for (const section of COURSE_SECTIONS) {
      const { sheetText } = composeCourseSection(baInput, section);
      expect(
        sheetText.length,
        `${section} body is ${sheetText.length} chars`
      ).toBeLessThanOrEqual(INTERACTIVE_LIMITS.bodyMaxLength);
    }
  });
});
