/**
 * Deterministic course-sheet composition (KB-COURSEINFO-R4-40).
 *
 * Renders the reply the bot sends the moment a lead taps a programme. Today
 * that turn costs an LLM call purely to PHRASE facts `Lead Classifier` has
 * already resolved - and when the provider is out of daily quota the lead gets
 * "I'm unable to verify that accurately right now" instead. This composes the
 * same answer from data, so the turn cannot fail on quota.
 *
 * PURE. No I/O, no DB, no Meta. Callers load the rows; this only formats them.
 * That is what makes it testable without mocks, matching `flows/engine.ts`.
 *
 * Two hard constraints inherited from `Deterministic Stage Guard` in the n8n
 * workflow, which sanitises every outbound bot reply:
 *   - WhatsApp bold is a SINGLE asterisk. `**` is rewritten to `*` downstream.
 *   - No URLs. A reply matching /https?:\/\// is replaced wholesale by the
 *     fallback, so a link would silently destroy the entire sheet.
 */

import { formatCurrency } from '@/lib/currency';
import type { FeeTemplate } from '@/lib/payments/types';
import { courseLabel } from './types';

/** Prose slots, ETL'd from the knowledge base into `course_content`. */
export interface CourseProse {
  overview?: string | null;
  duration?: string | null;
  eligibility?: string | null;
  credits?: string | null;
  medium?: string | null;
  careers?: string | null;
  electives?: string | null;
}

/**
 * One `fee_templates` row, already scoped to a single account. Structurally a
 * subset of the existing `FeeTemplate` domain type rather than a parallel
 * definition, so `loadFeeTemplates()` output can be passed straight in with no
 * adapter and no second shape to keep in sync.
 */
export type CourseFeeRow = Pick<
  FeeTemplate,
  | 'paymentOption'
  | 'termCount'
  | 'programmeFee'
  | 'examFee'
  | 'totalFee'
  | 'applicationFee'
  | 'studyMaterialFee'
  | 'currency'
>;

export interface ComposeInput {
  program: string;
  /** Canonical spelling from the crosswalk, e.g. "Political Science". */
  specialization?: string;
  mode: 'distance' | 'online';
  university: string;
  prose: CourseProse;
  fees: CourseFeeRow[];
  lang: 'en' | 'hi';
}

export interface ComposeResult {
  sheetText: string;
  /** Deterministic follow-ups, so a second question also costs no LLM call. */
  menuRows: { id: string; title: string; description?: string }[];
  /**
   * Whether a fee block was rendered, and how many rows were rejected for
   * failing their own arithmetic.
   *
   * Callers used to answer this by searching the rendered text for the literal
   * '*Fees*' / '*फीस*' - a proxy for something this function already knows,
   * which broke silently the moment a label changed and could not see a
   * PARTIAL drop at all (one payment option missing while the block still
   * renders). Report it directly instead.
   */
  feesRendered: boolean;
  feeRowsDropped: number;
}

const TERM_NOUN: Record<CourseFeeRow['paymentOption'], string> = {
  per_semester: 'semester',
  annual: 'year',
  lump_sum: 'one-time',
};

const L = {
  en: {
    duration: 'Duration',
    eligibility: 'Eligibility',
    credits: 'Credits',
    medium: 'Medium',
    fees: 'Fees',
    electives: 'Electives',
    careers: 'Careers',
    plusOneTime: 'Plus one-time',
    application: 'application',
    studyMaterial: 'study material',
    askMore: 'What would you like to know more about?',
    mFees: 'Fee details & EMI',
    mEligibility: 'Eligibility & documents',
    mAdmission: 'How to apply',
    mBrochure: 'Send me the brochure',
    mCounsellor: 'Talk to a counsellor',
    noFees: 'I do not have confirmed fees for this course right now. Shall I have a counsellor send them?',
    feeNote: 'Fees can be paid per semester, per year or in one payment. A counsellor can explain instalments.',
    docsNote: 'You will need your marksheets, a photo ID and a passport photo at admission.',
    applyNote:
      'To apply: share your marksheets and ID, pay the application fee, and your admission is registered. A Skeure Education counsellor can do this with you on a call.',
    applicationHeading: 'Application fee',
  },
  hi: {
    duration: 'अवधि',
    eligibility: 'योग्यता',
    credits: 'क्रेडिट',
    medium: 'माध्यम',
    fees: 'फीस',
    electives: 'वैकल्पिक विषय',
    careers: 'करियर',
    plusOneTime: 'इसके अतिरिक्त एक बार',
    application: 'आवेदन शुल्क',
    studyMaterial: 'अध्ययन सामग्री',
    askMore: 'आप और क्या जानना चाहेंगे?',
    mFees: 'फीस और EMI',
    mEligibility: 'योग्यता और दस्तावेज़',
    mAdmission: 'आवेदन कैसे करें',
    mBrochure: 'ब्रोशर भेजें',
    mCounsellor: 'काउंसलर से बात करें',
    noFees: 'इस कोर्स की पुष्ट फीस अभी उपलब्ध नहीं है। क्या काउंसलर से भिजवाऊं?',
    feeNote: 'फीस हर सेमेस्टर, हर साल या एक बार में दी जा सकती है। किस्तों के बारे में काउंसलर बता सकते हैं।',
    docsNote: 'प्रवेश के समय आपको मार्कशीट, फोटो पहचान पत्र और पासपोर्ट फोटो चाहिए होंगे।',
    applyNote:
      'आवेदन के लिए: मार्कशीट और पहचान पत्र भेजें, आवेदन शुल्क दें, और आपका प्रवेश दर्ज हो जाएगा। Skeure Education के काउंसलर कॉल पर यह करा सकते हैं।',
    applicationHeading: 'आवेदन शुल्क',
  },
} as const;

/**
 * Reject a fee row whose own arithmetic does not reconcile.
 *
 * Refusing to render an internally inconsistent row is what makes serving
 * unreviewed rows survivable: a suspect fee quote never reaches a lead, the
 * whole fee block is dropped and the turn falls through to a human instead.
 *
 * THE RULE: `n - 1` instalments of `(programmeFee + examFee)`, plus a final
 * instalment that is the remainder. That remainder must be positive and no
 * larger than a normal instalment.
 *
 * WHY NOT `(programmeFee + examFee) * termCount == totalFee`. That was the
 * original rule and it is wrong for real price lists, because the terms are
 * not always equal. `056_fee_plans_and_payments.sql` says so in its own header:
 * Amity's BA splits 115,000 as 19,200 x5 then 19,000, and term x per-term is
 * 200 rupees out. Measured against the live table, the exact-equality rule
 * rejects **248 of the active Amity rows** - every per_semester and every
 * annual one - while all 248 satisfy the rule below.
 *
 * That mattered less than it looks only because no Amity course is approved
 * yet. The day one is, every Amity sheet would have lost both instalment
 * options and quoted lump-sum only: the most cash-up-front option, presented
 * as though it were the only one, with a warning that reads like routine noise.
 *
 * This is a loosening, so it is worth being explicit that it does not weaken
 * the check it replaces. Everything the old rule caught, this still catches:
 *   - equal terms still reconcile exactly (the remainder equals an instalment)
 *   - an edited programmeFee (9,999 where 7,500 belongs) drives the remainder
 *     negative and is rejected
 *   - an inflated totalFee drives the remainder above one instalment and is
 *     rejected
 * What it newly accepts is precisely one thing: a final instalment smaller
 * than the others, which is a real pricing structure and not a data error.
 *
 * KEEP THIS IDENTICAL TO check-course-fee-health.sh. The single most repeated
 * defect in this project is a rule that must hold in two places, fixed in one
 * and eyeballed in the other - and this exact pair has already been an instance
 * of it once, when the SQL used COALESCE(programme_fee,0) against a null-reject
 * here. The SQL carries the same comment pointing back at this function.
 */
export function feeRowReconciles(row: CourseFeeRow): boolean {
  const { programmeFee: p, examFee: e, totalFee: t, termCount: n } = row;
  if (p == null || t == null || n == null) return false;
  const perTerm = Number(p) + Number(e ?? 0);
  const terms = Number(n);
  const total = Number(t);
  if (!(terms >= 1) || !(perTerm > 0)) return false;

  // A single term has no remainder to be lenient about: the total IS the
  // instalment. Every lump_sum row in fee_templates has term_count 1, so
  // without this branch the remainder test below degenerates to "total > 0"
  // and would accept any number at all as a lump-sum price.
  if (terms === 1) return Math.abs(total - perTerm) < 1;

  const finalTerm = total - perTerm * (terms - 1);
  // Positive, and no bigger than a normal instalment. The +1 absorbs sub-rupee
  // float drift on the upper bound only.
  return finalTerm > 0 && finalTerm <= perTerm + 1;
}

function feeLine(row: CourseFeeRow): string {
  const cur = row.currency || 'INR';
  const perTerm = Number(row.programmeFee ?? 0) + Number(row.examFee ?? 0);
  const total = formatCurrency(Number(row.totalFee ?? 0), cur);
  if (row.paymentOption === 'lump_sum') {
    return `${TERM_NOUN.lump_sum}: ${total}`;
  }
  const noun = TERM_NOUN[row.paymentOption];
  return `${formatCurrency(perTerm, cur)} per ${noun} x ${row.termCount} = ${total}`;
}

/**
 * The fee block, built once and shared by the full sheet and the `fees`
 * follow-up. These were copy-pasted, so a change to the payment ordering or the
 * one-off extras in one would silently not apply to the other.
 */
function feeBlockLines(
  usable: CourseFeeRow[],
  t: (typeof L)['en'] | (typeof L)['hi']
): string[] {
  if (usable.length === 0) return [];
  const lines = [`*${t.fees}*`];
  // Stable order regardless of how the rows arrived.
  const order: CourseFeeRow['paymentOption'][] = [
    'per_semester',
    'annual',
    'lump_sum',
  ];
  for (const opt of order) {
    const row = usable.find((r) => r.paymentOption === opt);
    if (row) lines.push(feeLine(row));
  }
  const first = usable[0];
  const extras: string[] = [];
  if (first.applicationFee)
    extras.push(
      `${formatCurrency(Number(first.applicationFee), first.currency)} ${t.application}`
    );
  if (first.studyMaterialFee)
    extras.push(
      `${formatCurrency(Number(first.studyMaterialFee), first.currency)} ${t.studyMaterial}`
    );
  if (extras.length) lines.push(`${t.plusOneTime}: ${extras.join(', ')}.`);
  return lines;
}

/** Strip anything the downstream Stage Guard would reject the whole reply for. */
function safe(s: string): string {
  return s
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\*\*+/g, '*')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export function composeCourseSheet(input: ComposeInput): ComposeResult {
  const t = L[input.lang];
  const { prose, program, specialization, mode, university } = input;

  // One implementation of the course title, shared with the review UI.
  const title = courseLabel({ program, specialization: specialization ?? '', university, mode });

  const lines: string[] = [`*${safe(title)}*`];

  if (prose.overview) lines.push('', safe(prose.overview));

  const facts: string[] = [];
  if (prose.duration) facts.push(`*${t.duration}:* ${safe(prose.duration)}`);
  if (prose.eligibility)
    facts.push(`*${t.eligibility}:* ${safe(prose.eligibility)}`);
  if (prose.credits) facts.push(`*${t.credits}:* ${safe(prose.credits)}`);
  if (prose.medium) facts.push(`*${t.medium}:* ${safe(prose.medium)}`);
  if (facts.length) lines.push('', ...facts);

  const usable = input.fees.filter(feeRowReconciles);
  const feeLines = feeBlockLines(usable, t);
  if (feeLines.length) lines.push('', ...feeLines);

  if (prose.electives)
    lines.push('', `*${t.electives}:* ${safe(prose.electives)}`);
  if (prose.careers) lines.push('', `*${t.careers}:* ${safe(prose.careers)}`);

  const menuRows = [
    { id: 'ci:fees', title: t.mFees },
    { id: 'ci:eligibility', title: t.mEligibility },
    { id: 'ci:admission', title: t.mAdmission },
    { id: 'ci:brochure', title: t.mBrochure },
    { id: 'ci:counsellor', title: t.mCounsellor },
  ];

  return {
    sheetText: lines.join('\n'),
    menuRows,
    feesRendered: usable.length > 0,
    feeRowsDropped: input.fees.length - usable.length,
  };
}

/**
 * The follow-up sections behind the sheet's menu buttons.
 *
 * Without these, four of five buttons fell through to the LLM that is out of
 * daily quota — a menu promising instant answers delivering exactly the failure
 * this feature exists to remove. Every section is composed from the same rows
 * the sheet used, so a second question also costs no model call.
 */
export const COURSE_SECTIONS = ['fees', 'eligibility', 'admission'] as const;
export type CourseSection = (typeof COURSE_SECTIONS)[number];

export function composeCourseSection(
  input: ComposeInput,
  section: CourseSection
): ComposeResult {
  const t = L[input.lang];
  const { prose } = input;
  const usable = input.fees.filter(feeRowReconciles);
  const lines: string[] = [
    `*${safe(
      courseLabel({
        program: input.program,
        specialization: input.specialization ?? '',
        university: input.university,
        mode: input.mode,
      })
    )}*`,
  ];

  /**
   * A human is always one tap away.
   *
   * composeCourseSheet guarantees this and it is unit-tested; the first version
   * of this function hardcoded an empty menu, so a lead who tapped "Fee details"
   * got fees and no route to a person. With the escalation tier out of quota
   * that is the worst place to strand someone.
   */
  const menuRows = [{ id: 'ci:counsellor', title: t.mCounsellor }];

  switch (section) {
    case 'fees': {
      const feeLines = feeBlockLines(usable, t);
      if (feeLines.length === 0) {
        // Never invent a number. Offer a person instead.
        lines.push('', t.noFees);
        return { sheetText: lines.join('\n'), menuRows, feesRendered: false, feeRowsDropped: input.fees.length };
      }
      lines.push('', ...feeLines, '', t.feeNote);
      return {
        sheetText: lines.join('\n'),
        menuRows,
        feesRendered: true,
        feeRowsDropped: input.fees.length - usable.length,
      };
    }

    case 'eligibility': {
      if (prose.eligibility) lines.push('', `*${t.eligibility}:* ${safe(prose.eligibility)}`);
      if (prose.duration) lines.push(`*${t.duration}:* ${safe(prose.duration)}`);
      if (prose.credits) lines.push(`*${t.credits}:* ${safe(prose.credits)}`);
      lines.push('', t.docsNote);
      return { sheetText: lines.join('\n'), menuRows, feesRendered: false, feeRowsDropped: 0 };
    }

    case 'admission': {
      // There is no admission-steps field in course_content, so this states the
      // two things we can say truthfully and hands the rest to a person rather
      // than inventing a process.
      if (prose.eligibility) lines.push('', `*${t.eligibility}:* ${safe(prose.eligibility)}`);
      const appFee = usable[0]?.applicationFee;
      if (appFee)
        lines.push(
          `*${t.applicationHeading}:* ${formatCurrency(Number(appFee), usable[0].currency)}`
        );
      lines.push('', t.applyNote);
      return { sheetText: lines.join('\n'), menuRows, feesRendered: false, feeRowsDropped: 0 };
    }

    default: {
      // Adding a section without handling it must fail to compile, not silently
      // fall through to whichever branch happens to be last.
      const exhaustive: never = section;
      throw new Error(`unhandled course section: ${String(exhaustive)}`);
    }
  }
}
