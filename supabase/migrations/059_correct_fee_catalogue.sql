-- 059_correct_fee_catalogue.sql
-- KB-FEEPAY-R4-38
--
-- Replaces the LPU Online and Amity catalogues seeded by migration 058 with
-- the operator's July 2026 fee sheets, supplied 2026-08-20:
--
--   docs/fee structures/JULY 26 FEE STRCUTURE - LPU  .csv
--   docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv
--
-- LPU DISTANCE IS NOT TOUCHED. The operator confirmed its brochures and
-- knowledge base are current, and its knowledge base carries no grant or
-- discount, so those list prices are already what a student pays.
--
-- Three things 058 got wrong, in ascending order of how much they mattered:
--
--   1. Stale figures. The brochures under brochures/LPU predate a fee
--      revision the sheet marks "Fee changed": MCA 37,000 -> 40,000 per
--      semester, M.Sc 20,000 -> 25,000. DBA and DCA were seeded as Distance
--      only; they are Online two-semester programmes too.
--
--   2. Wrong registration fee. The brochures say 600 and the sheet says
--      1,000. On the strength of the brochures the bot's knowledge base was
--      "corrected" from 1,000 to 600 on 2026-08-19; that change has been
--      reverted and the knowledge base restored byte for byte. The knowledge
--      base was right and the brochures are stale. See decisions/log.md.
--
--   3. LIST PRICES SEEDED AS WHAT A STUDENT PAYS. This was the real damage.
--      Every LPU Online programme carries a 20% Student Grant, and 058 stored
--      the pre-grant price, so applying an MBA plan would have quoted 200,000
--      against a true 161,600 — a 38,400 overstatement on every student.
--      What is stored now is the net figure, with list_discount_pct recording
--      why it is lower than the brochure.
--
-- The sheet's own footnotes reconstruct every figure, which is what makes
-- these safe to seed unreviewed line by line:
--
--   "Examination Fee Rs. 2000 per sem. is Included"  — the Actual Fee column
--     is programme + exam, so the grant base is Actual - 2,000.
--   "Student Grant-I @20% waiver on actual Programme Fee" — MBA:
--     (50,000 - 2,000) x 0.8 + 2,000 = 40,400, exactly the sheet's figure.
--   Lumpsum "@20% ... and additional 10% on ... per semester fee after Student
--     Grant" — 48,000 x 0.8 x 0.9 x 4 + 2,000 x 4 = 146,240, exactly the
--     sheet's MBA lumpsum.
--
--   All 14 programmes pass both checks. The "No Cost EMI" column is not seeded
--   as a separate option: its total equals the per-semester total for every
--   programme, so it is the same price financed rather than a different one.
--
-- Amity now carries BOTH of the sheet's blocks, told apart by `variant`:
--   "Direct payment" — 12% UG / 8% PG one-time, 5% yearly
--   "Loan"          — 5% one-time, 3% yearly, headed "FOR LOAN GENERAL"
-- Migration 058 seeded only the first, on the assumption the second was a
-- stale duplicate. The sheet's headers show they are two payment routes, both
-- current; which applies is a property of the student, not the programme.
--
-- Amity totals come from the retail figure recovered as one-time fee divided
-- by one minus its discount (BA: 101,200 / 0.88 = 115,000), not from
-- multiplying the per-term figure. Amity's final term absorbs the rounding
-- (19,200 x5 then 19,000), so multiplying would over-quote by about 200.
--
-- Safe to replace rather than amend: student plans snapshot their amounts when
-- applied (migration 056) and template_id is ON DELETE SET NULL, so no
-- existing student's balance can move. Verified 0 plans and 0 payments at the
-- time of writing.
--
-- Rollback: re-apply 058 after deleting rows sourced from 'sheet:%'.

DELETE FROM fee_templates
WHERE (university = 'LPU' AND mode = 'online') OR university = 'AMI';

INSERT INTO fee_templates (
  account_id, university, mode, program, specialization, payment_option,
  term_count, programme_fee, exam_fee, total_fee, application_fee,
  list_discount_pct, variant, currency, source, effective_from
)
SELECT
  a.id, v.university, v.mode, v.program, v.specialization,
  v.payment_option::fee_payment_option_enum,
  v.term_count, v.programme_fee, v.exam_fee, v.total_fee, v.application_fee,
  v.list_discount_pct, v.variant, v.currency, v.source,
  DATE '2026-07-01'
FROM accounts a
CROSS JOIN (VALUES
  ('AMI', 'online', 'BA', '', 'annual', 3, 36420, NULL, 109250, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BA', '', 'annual', 3, 37190, NULL, 111550, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BA', '', 'lump_sum', 1, 101200, NULL, 101200, NULL, 12, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BA', '', 'lump_sum', 1, 109250, NULL, 109250, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BA', '', 'per_semester', 6, 19200, NULL, 115000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BA', '', 'per_semester', 6, 19200, NULL, 115000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BA', 'JMC', 'annual', 3, 60170, NULL, 180500, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BA', 'JMC', 'annual', 3, 61440, NULL, 184300, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BA', 'JMC', 'lump_sum', 1, 167200, NULL, 167200, NULL, 12, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BA', 'JMC', 'lump_sum', 1, 180500, NULL, 180500, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BA', 'JMC', 'per_semester', 6, 31700, NULL, 190000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BA', 'JMC', 'per_semester', 6, 31700, NULL, 190000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BA', 'VERNACULAR', 'annual', 3, 30000, NULL, 90000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BA', 'VERNACULAR', 'annual', 3, 30000, NULL, 90000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BA', 'VERNACULAR', 'lump_sum', 1, 90000, NULL, 90000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BA', 'VERNACULAR', 'lump_sum', 1, 90000, NULL, 90000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', '', 'annual', 3, 63020, NULL, 189050, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', '', 'annual', 3, 64350, NULL, 193030, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', '', 'lump_sum', 1, 175120, NULL, 175120, NULL, 12, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', '', 'lump_sum', 1, 189050, NULL, 189050, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', '', 'per_semester', 6, 33200, NULL, 199000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', '', 'per_semester', 6, 33200, NULL, 199000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', 'HCLTECH DATA ANALYTICS', 'annual', 3, 79170, NULL, 237500, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', 'HCLTECH DATA ANALYTICS', 'annual', 3, 80840, NULL, 242500, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', 'HCLTECH DATA ANALYTICS', 'lump_sum', 1, 220000, NULL, 220000, NULL, 12, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', 'HCLTECH DATA ANALYTICS', 'lump_sum', 1, 237500, NULL, 237500, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', 'HCLTECH DATA ANALYTICS', 'per_semester', 6, 41700, NULL, 250000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', 'HCLTECH DATA ANALYTICS', 'per_semester', 6, 41700, NULL, 250000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', 'KPMG BAP', 'annual', 3, 72840, NULL, 218500, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', 'KPMG BAP', 'annual', 3, 74370, NULL, 223100, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', 'KPMG BAP', 'lump_sum', 1, 202400, NULL, 202400, NULL, 12, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', 'KPMG BAP', 'lump_sum', 1, 218500, NULL, 218500, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', 'KPMG BAP', 'per_semester', 6, 38400, NULL, 230000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', 'KPMG BAP', 'per_semester', 6, 38400, NULL, 230000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', 'LENSKART', 'annual', 3, 87090, NULL, 261250, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', 'LENSKART', 'annual', 3, 88920, NULL, 266750, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', 'LENSKART', 'lump_sum', 1, 242000, NULL, 242000, NULL, 12, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', 'LENSKART', 'lump_sum', 1, 261250, NULL, 261250, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', 'LENSKART', 'per_semester', 6, 45900, NULL, 275000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', 'LENSKART', 'per_semester', 6, 45900, NULL, 275000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', 'MBA', 'annual', 3, 127560, NULL, 382653, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', 'MBA', 'annual', 3, 130240, NULL, 390716, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', 'MBA', 'lump_sum', 1, 370570, NULL, 370570, NULL, 8, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', 'MBA', 'lump_sum', 1, 382660, NULL, 382660, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', 'MBA', 'per_semester', 6, 67200, NULL, 402793, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BBA', 'MBA', 'per_semester', 6, 67200, NULL, 402800, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', '', 'annual', 3, 55420, NULL, 166250, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', '', 'annual', 3, 56590, NULL, 169750, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', '', 'lump_sum', 1, 154000, NULL, 154000, NULL, 12, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', '', 'lump_sum', 1, 166250, NULL, 166250, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', '', 'per_semester', 6, 29200, NULL, 175000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', '', 'per_semester', 6, 29200, NULL, 175000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'FINTECH', 'annual', 3, 87090, NULL, 261250, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'FINTECH', 'annual', 3, 88920, NULL, 266750, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'FINTECH', 'lump_sum', 1, 242000, NULL, 242000, NULL, 12, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'FINTECH', 'lump_sum', 1, 261250, NULL, 261250, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'FINTECH', 'per_semester', 6, 45900, NULL, 275000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'FINTECH', 'per_semester', 6, 45900, NULL, 275000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'HCLTECH DATA ENGINEERING', 'annual', 3, 79170, NULL, 237500, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'HCLTECH DATA ENGINEERING', 'annual', 3, 80840, NULL, 242500, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'HCLTECH DATA ENGINEERING', 'lump_sum', 1, 220000, NULL, 220000, NULL, 12, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'HCLTECH DATA ENGINEERING', 'lump_sum', 1, 237500, NULL, 237500, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'HCLTECH DATA ENGINEERING', 'per_semester', 6, 41700, NULL, 250000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'HCLTECH DATA ENGINEERING', 'per_semester', 6, 41700, NULL, 250000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'HCLTECH SOFTWARE ENGINEERING', 'annual', 3, 79170, NULL, 237500, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'HCLTECH SOFTWARE ENGINEERING', 'annual', 3, 80840, NULL, 242500, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'HCLTECH SOFTWARE ENGINEERING', 'lump_sum', 1, 220000, NULL, 220000, NULL, 12, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'HCLTECH SOFTWARE ENGINEERING', 'lump_sum', 1, 237500, NULL, 237500, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'HCLTECH SOFTWARE ENGINEERING', 'per_semester', 6, 41700, NULL, 250000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'HCLTECH SOFTWARE ENGINEERING', 'per_semester', 6, 41700, NULL, 250000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'KPMG ADE', 'annual', 3, 72840, NULL, 218500, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'KPMG ADE', 'annual', 3, 74370, NULL, 223100, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'KPMG ADE', 'lump_sum', 1, 202400, NULL, 202400, NULL, 12, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'KPMG ADE', 'lump_sum', 1, 218500, NULL, 218500, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'KPMG ADE', 'per_semester', 6, 38400, NULL, 230000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'KPMG ADE', 'per_semester', 6, 38400, NULL, 230000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'MCA', 'annual', 3, 112510, NULL, 337528, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'MCA', 'annual', 3, 114880, NULL, 344636, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'MCA', 'lump_sum', 1, 326870, NULL, 326870, NULL, 8, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'MCA', 'lump_sum', 1, 337530, NULL, 337530, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'MCA', 'per_semester', 6, 59300, NULL, 355293, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'MCA', 'per_semester', 6, 59300, NULL, 355295, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'TCSION CLOUDSECURITY', 'annual', 3, 79170, NULL, 237500, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'TCSION CLOUDSECURITY', 'annual', 3, 80840, NULL, 242500, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'TCSION CLOUDSECURITY', 'lump_sum', 1, 220000, NULL, 220000, NULL, 12, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'TCSION CLOUDSECURITY', 'lump_sum', 1, 237500, NULL, 237500, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'TCSION CLOUDSECURITY', 'per_semester', 6, 41700, NULL, 250000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'TCSION CLOUDSECURITY', 'per_semester', 6, 41700, NULL, 250000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'TCSION DATAANALYTICS', 'annual', 3, 79170, NULL, 237500, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'TCSION DATAANALYTICS', 'annual', 3, 80840, NULL, 242500, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'TCSION DATAANALYTICS', 'lump_sum', 1, 220000, NULL, 220000, NULL, 12, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'TCSION DATAANALYTICS', 'lump_sum', 1, 237500, NULL, 237500, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'TCSION DATAANALYTICS', 'per_semester', 6, 41700, NULL, 250000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCA', 'TCSION DATAANALYTICS', 'per_semester', 6, 41700, NULL, 250000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCOM', '', 'annual', 3, 36420, NULL, 109250, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCOM', '', 'annual', 3, 37190, NULL, 111550, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCOM', '', 'lump_sum', 1, 101200, NULL, 101200, NULL, 12, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCOM', '', 'lump_sum', 1, 109250, NULL, 109250, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCOM', '', 'per_semester', 6, 19200, NULL, 115000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCOM', '', 'per_semester', 6, 19200, NULL, 115000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCOM', 'ACCA', 'annual', 3, 87090, NULL, 261250, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCOM', 'ACCA', 'annual', 3, 88920, NULL, 266750, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCOM', 'ACCA', 'lump_sum', 1, 242000, NULL, 242000, NULL, 12, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCOM', 'ACCA', 'lump_sum', 1, 261250, NULL, 261250, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCOM', 'ACCA', 'per_semester', 6, 45900, NULL, 275000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCOM', 'ACCA', 'per_semester', 6, 45900, NULL, 275000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCOM', 'HONS', 'annual', 3, 55420, NULL, 166250, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCOM', 'HONS', 'annual', 3, 56590, NULL, 169750, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCOM', 'HONS', 'lump_sum', 1, 154000, NULL, 154000, NULL, 12, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCOM', 'HONS', 'lump_sum', 1, 166250, NULL, 166250, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCOM', 'HONS', 'per_semester', 6, 29200, NULL, 175000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCOM', 'HONS', 'per_semester', 6, 29200, NULL, 175000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCOM', 'MBA', 'annual', 3, 102290, NULL, 306850, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCOM', 'MBA', 'annual', 3, 104440, NULL, 313310, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCOM', 'MBA', 'lump_sum', 1, 297160, NULL, 297160, NULL, 8, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCOM', 'MBA', 'lump_sum', 1, 306850, NULL, 306850, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCOM', 'MBA', 'per_semester', 6, 53900, NULL, 323000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCOM', 'MBA', 'per_semester', 6, 53900, NULL, 323000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCOM', 'VERNACULAR', 'annual', 3, 30000, NULL, 90000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCOM', 'VERNACULAR', 'annual', 3, 30000, NULL, 90000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCOM', 'VERNACULAR', 'lump_sum', 1, 90000, NULL, 90000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BCOM', 'VERNACULAR', 'lump_sum', 1, 90000, NULL, 90000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BFP', '', 'lump_sum', 1, 49000, NULL, 49000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'BFP', '', 'lump_sum', 1, 49000, NULL, 49000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MA', 'JMC', 'annual', 2, 90250, NULL, 180500, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MA', 'JMC', 'annual', 2, 92150, NULL, 184300, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MA', 'JMC', 'lump_sum', 1, 174800, NULL, 174800, NULL, 8, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MA', 'JMC', 'lump_sum', 1, 180500, NULL, 180500, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MA', 'JMC', 'per_semester', 4, 47500, NULL, 190000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MA', 'JMC', 'per_semester', 4, 47500, NULL, 190000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MA', 'PPG', 'annual', 2, 71250, NULL, 142500, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MA', 'PPG', 'annual', 2, 72750, NULL, 145500, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MA', 'PPG', 'lump_sum', 1, 138000, NULL, 138000, NULL, 8, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MA', 'PPG', 'lump_sum', 1, 142500, NULL, 142500, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MA', 'PPG', 'per_semester', 4, 37500, NULL, 150000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MA', 'PPG', 'per_semester', 4, 37500, NULL, 150000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', '', 'annual', 2, 106880, NULL, 213750, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', '', 'annual', 2, 109130, NULL, 218250, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', '', 'lump_sum', 1, 207000, NULL, 207000, NULL, 8, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', '', 'lump_sum', 1, 213750, NULL, 213750, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', '', 'per_semester', 4, 56300, NULL, 225000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', '', 'per_semester', 4, 56300, NULL, 225000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', 'ACCA', 'annual', 2, 156280, NULL, 312550, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', 'ACCA', 'annual', 2, 159570, NULL, 319130, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', 'ACCA', 'lump_sum', 1, 302680, NULL, 302680, NULL, 8, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', 'ACCA', 'lump_sum', 1, 312550, NULL, 312550, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', 'ACCA', 'per_semester', 4, 82300, NULL, 329000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', 'ACCA', 'per_semester', 4, 82300, NULL, 329000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', 'DUAL SPECIALIZATION', 'annual', 2, 156280, NULL, 312550, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', 'DUAL SPECIALIZATION', 'annual', 2, 159570, NULL, 319130, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', 'DUAL SPECIALIZATION', 'lump_sum', 1, 302680, NULL, 302680, NULL, 8, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', 'DUAL SPECIALIZATION', 'lump_sum', 1, 312550, NULL, 312550, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', 'DUAL SPECIALIZATION', 'per_semester', 4, 82300, NULL, 329000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', 'DUAL SPECIALIZATION', 'per_semester', 4, 82300, NULL, 329000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', 'HHM', 'annual', 2, 156280, NULL, 312550, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', 'HHM', 'annual', 2, 159570, NULL, 319130, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', 'HHM', 'lump_sum', 1, 302680, NULL, 302680, NULL, 8, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', 'HHM', 'lump_sum', 1, 312550, NULL, 312550, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', 'HHM', 'per_semester', 4, 82300, NULL, 329000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', 'HHM', 'per_semester', 4, 82300, NULL, 329000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', 'LENSKART', 'annual', 2, 130630, NULL, 261250, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', 'LENSKART', 'annual', 2, 133380, NULL, 266750, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', 'LENSKART', 'lump_sum', 1, 253000, NULL, 253000, NULL, 8, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', 'LENSKART', 'lump_sum', 1, 261250, NULL, 261250, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', 'LENSKART', 'per_semester', 4, 68800, NULL, 275000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MBA', 'LENSKART', 'per_semester', 4, 68800, NULL, 275000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', '', 'annual', 2, 94530, NULL, 189050, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', '', 'annual', 2, 96520, NULL, 193030, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', '', 'lump_sum', 1, 183080, NULL, 183080, NULL, 8, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', '', 'lump_sum', 1, 189050, NULL, 189050, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', '', 'per_semester', 4, 49800, NULL, 199000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', '', 'per_semester', 4, 49800, NULL, 199000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'FINTECH', 'annual', 2, 130630, NULL, 261250, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'FINTECH', 'annual', 2, 133380, NULL, 266750, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'FINTECH', 'lump_sum', 1, 253000, NULL, 253000, NULL, 8, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'FINTECH', 'lump_sum', 1, 261250, NULL, 261250, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'FINTECH', 'per_semester', 4, 68800, NULL, 275000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'FINTECH', 'per_semester', 4, 68800, NULL, 275000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'HCLTECH CYBERSECURITY', 'annual', 2, 130630, NULL, 261250, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'HCLTECH CYBERSECURITY', 'annual', 2, 133380, NULL, 266750, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'HCLTECH CYBERSECURITY', 'lump_sum', 1, 253000, NULL, 253000, NULL, 8, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'HCLTECH CYBERSECURITY', 'lump_sum', 1, 261250, NULL, 261250, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'HCLTECH CYBERSECURITY', 'per_semester', 4, 68800, NULL, 275000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'HCLTECH CYBERSECURITY', 'per_semester', 4, 68800, NULL, 275000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'HCLTECH SOFTWARE ENGINEERING', 'annual', 2, 130630, NULL, 261250, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'HCLTECH SOFTWARE ENGINEERING', 'annual', 2, 133380, NULL, 266750, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'HCLTECH SOFTWARE ENGINEERING', 'lump_sum', 1, 253000, NULL, 253000, NULL, 8, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'HCLTECH SOFTWARE ENGINEERING', 'lump_sum', 1, 261250, NULL, 261250, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'HCLTECH SOFTWARE ENGINEERING', 'per_semester', 4, 68800, NULL, 275000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'HCLTECH SOFTWARE ENGINEERING', 'per_semester', 4, 68800, NULL, 275000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'TCSION ARVR', 'annual', 2, 130630, NULL, 261250, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'TCSION ARVR', 'annual', 2, 133380, NULL, 266750, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'TCSION ARVR', 'lump_sum', 1, 253000, NULL, 253000, NULL, 8, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'TCSION ARVR', 'lump_sum', 1, 261250, NULL, 261250, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'TCSION ARVR', 'per_semester', 4, 68800, NULL, 275000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'TCSION ARVR', 'per_semester', 4, 68800, NULL, 275000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'TCSION ML', 'annual', 2, 130630, NULL, 261250, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'TCSION ML', 'annual', 2, 133380, NULL, 266750, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'TCSION ML', 'lump_sum', 1, 253000, NULL, 253000, NULL, 8, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'TCSION ML', 'lump_sum', 1, 261250, NULL, 261250, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'TCSION ML', 'per_semester', 4, 68800, NULL, 275000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCA', 'TCSION ML', 'per_semester', 4, 68800, NULL, 275000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCOM', 'FM', 'annual', 2, 71250, NULL, 142500, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCOM', 'FM', 'annual', 2, 72750, NULL, 145500, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCOM', 'FM', 'lump_sum', 1, 138000, NULL, 138000, NULL, 8, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCOM', 'FM', 'lump_sum', 1, 142500, NULL, 142500, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCOM', 'FM', 'per_semester', 4, 37500, NULL, 150000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MCOM', 'FM', 'per_semester', 4, 37500, NULL, 150000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MSC', 'DATASCIENCE', 'annual', 2, 130630, NULL, 261250, NULL, 5, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MSC', 'DATASCIENCE', 'annual', 2, 133380, NULL, 266750, NULL, 3, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MSC', 'DATASCIENCE', 'lump_sum', 1, 253000, NULL, 253000, NULL, 8, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MSC', 'DATASCIENCE', 'lump_sum', 1, 261250, NULL, 261250, NULL, 5, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MSC', 'DATASCIENCE', 'per_semester', 4, 68800, NULL, 275000, NULL, NULL, 'Direct payment', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('AMI', 'online', 'MSC', 'DATASCIENCE', 'per_semester', 4, 68800, NULL, 275000, NULL, NULL, 'Loan', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - AMITY .csv'),
  ('LPU', 'online', 'BA', '', 'lump_sum', 1, 77760, 12000, 89760, 1000, 28, '', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - LPU  .csv'),
  ('LPU', 'online', 'BA', '', 'per_semester', 6, 14400, 2000, 98400, 1000, 20, '', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - LPU  .csv'),
  ('LPU', 'online', 'BBA', '', 'lump_sum', 1, 99360, 12000, 111360, 1000, 28, '', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - LPU  .csv'),
  ('LPU', 'online', 'BBA', '', 'per_semester', 6, 18400, 2000, 122400, 1000, 20, '', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - LPU  .csv'),
  ('LPU', 'online', 'BCA', '', 'lump_sum', 1, 99360, 12000, 111360, 1000, 28, '', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - LPU  .csv'),
  ('LPU', 'online', 'BCA', '', 'per_semester', 6, 18400, 2000, 122400, 1000, 20, '', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - LPU  .csv'),
  ('LPU', 'online', 'DBA', '', 'lump_sum', 1, 33120, 4000, 37120, 1000, 28, '', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - LPU  .csv'),
  ('LPU', 'online', 'DBA', '', 'per_semester', 2, 18400, 2000, 40800, 1000, 20, '', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - LPU  .csv'),
  ('LPU', 'online', 'DCA', '', 'lump_sum', 1, 33120, 4000, 37120, 1000, 28, '', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - LPU  .csv'),
  ('LPU', 'online', 'DCA', '', 'per_semester', 2, 18400, 2000, 40800, 1000, 20, '', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - LPU  .csv'),
  ('LPU', 'online', 'MA', 'English', 'lump_sum', 1, 51840, 8000, 59840, 1000, 28, '', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - LPU  .csv'),
  ('LPU', 'online', 'MA', 'English', 'per_semester', 4, 14400, 2000, 65600, 1000, 20, '', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - LPU  .csv'),
  ('LPU', 'online', 'MA', 'History', 'lump_sum', 1, 51840, 8000, 59840, 1000, 28, '', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - LPU  .csv'),
  ('LPU', 'online', 'MA', 'History', 'per_semester', 4, 14400, 2000, 65600, 1000, 20, '', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - LPU  .csv'),
  ('LPU', 'online', 'MA', 'Political Science', 'lump_sum', 1, 51840, 8000, 59840, 1000, 28, '', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - LPU  .csv'),
  ('LPU', 'online', 'MA', 'Political Science', 'per_semester', 4, 14400, 2000, 65600, 1000, 20, '', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - LPU  .csv'),
  ('LPU', 'online', 'MA', 'Sociology', 'lump_sum', 1, 51840, 8000, 59840, 1000, 28, '', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - LPU  .csv'),
  ('LPU', 'online', 'MA', 'Sociology', 'per_semester', 4, 14400, 2000, 65600, 1000, 20, '', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - LPU  .csv'),
  ('LPU', 'online', 'MBA', '', 'lump_sum', 1, 138240, 8000, 146240, 1000, 28, '', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - LPU  .csv'),
  ('LPU', 'online', 'MBA', '', 'per_semester', 4, 38400, 2000, 161600, 1000, 20, '', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - LPU  .csv'),
  ('LPU', 'online', 'MCA', '', 'lump_sum', 1, 109440, 8000, 117440, 1000, 28, '', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - LPU  .csv'),
  ('LPU', 'online', 'MCA', '', 'per_semester', 4, 30400, 2000, 129600, 1000, 20, '', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - LPU  .csv'),
  ('LPU', 'online', 'MCOM', '', 'lump_sum', 1, 66240, 8000, 74240, 1000, 28, '', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - LPU  .csv'),
  ('LPU', 'online', 'MCOM', '', 'per_semester', 4, 18400, 2000, 81600, 1000, 20, '', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - LPU  .csv'),
  ('LPU', 'online', 'MSC', 'Economics', 'lump_sum', 1, 66240, 8000, 74240, 1000, 28, '', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - LPU  .csv'),
  ('LPU', 'online', 'MSC', 'Economics', 'per_semester', 4, 18400, 2000, 81600, 1000, 20, '', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - LPU  .csv'),
  ('LPU', 'online', 'MSC', 'Mathematics', 'lump_sum', 1, 66240, 8000, 74240, 1000, 28, '', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - LPU  .csv'),
  ('LPU', 'online', 'MSC', 'Mathematics', 'per_semester', 4, 18400, 2000, 81600, 1000, 20, '', 'INR', 'sheet:docs/fee structures/JULY 26 FEE STRCUTURE - LPU  .csv')
) AS v(university, mode, program, specialization, payment_option,
       term_count, programme_fee, exam_fee, total_fee, application_fee,
       list_discount_pct, variant, currency, source)
WHERE NOT EXISTS (
  SELECT 1 FROM fee_templates t
  WHERE t.account_id = a.id
    AND t.university = v.university
    AND t.mode = v.mode
    AND t.program = v.program
    AND t.specialization = v.specialization
    AND t.payment_option = v.payment_option::fee_payment_option_enum
    AND t.variant = v.variant
    AND t.effective_from = DATE '2026-07-01'
);
