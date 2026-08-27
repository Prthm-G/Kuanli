-- 058_seed_fee_templates.sql
-- KB-FEEPAY-R4-36
--
-- The fee catalogue, extracted by devtools/extract-fee-templates.mjs and
-- reviewed by the operator on 2026-08-19 before this file was written.
-- 237 rows across three universities.
--
-- Sources, in the order they win:
--
--   LPU Distance  brochures/LPU - Distance/**/*.pdf  (100 rows)
--     Primary documents. Every row's programme fee plus examination fee equals
--     the total the brochure itself prints; zero mismatches across all 100.
--
--   LPU Online    brochures/LPU/**/*.pdf  (30 rows)
--     Also primary, and chosen over the bot knowledge base at the operator's
--     direction. Where the two disagree the bot is wrong: it tells students the
--     initial registration fee is Rs 1,000 and every brochure says 600.
--     The knowledge base was kept only as a check, and it pinned down how the
--     Student Grant works: 20 percent of the PROGRAMME fee, not the
--     examination fee. 48,000 x 0.8 + 2,000 = 40,400 is exactly the net the bot
--     publishes, and the same arithmetic reproduces the BA's 16,400. 22 of the
--     30 agree to the rupee and carry the grant. The 8 that do not (MCA, MSc)
--     are seeded as list prices with NO grant recorded: no percentage
--     reproduces the quoted net from the brochure price, one of the two sources
--     is stale, and guessing which would put a wrong number in front of a
--     student.
--
--   Amity  brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx  (107 rows)
--     Block 1 of the sheet only, the higher-discount tier, per the operator.
--     The sheet prices every programme a second time at 5/3 percent with
--     nothing explaining the difference; that block is not seeded.
--     Amity rows carry no examination or registration fee because the sheet has
--     no such column. Treated as all-inclusive for now; extras land later if
--     Amity confirms any.
--
--   DBU  not seeded. Both brochures are scanned images with no text layer, so
--     there is nothing to extract. Enter by hand.
--
-- Seeded per account and idempotent: effective_from is pinned to the July 2026
-- structure every source is stamped with, so re-running matches on the unique
-- key instead of minting a second copy dated today.
--
-- These are LIST prices. A student's plan snapshots them at the moment it is
-- applied (migration 056), so correcting a row later never moves an existing
-- student's balance.
--
-- Rollback:
--   DELETE FROM fee_templates
--   WHERE effective_from = DATE '2026-07-01'
--     AND (source LIKE 'brochure:%' OR source LIKE 'xlsx:%');

INSERT INTO fee_templates (
  account_id, university, mode, program, specialization, payment_option,
  term_count, programme_fee, exam_fee, total_fee, application_fee,
  study_material_fee, list_discount_pct, currency, source, effective_from
)
SELECT
  a.id, v.university, v.mode, v.program, v.specialization,
  v.payment_option::fee_payment_option_enum,
  v.term_count, v.programme_fee, v.exam_fee, v.total_fee, v.application_fee,
  v.study_material_fee, v.list_discount_pct, v.currency, v.source,
  DATE '2026-07-01'
FROM accounts a
CROSS JOIN (VALUES
  ('AMI', 'online', 'BA', '', 'annual', 3, 36420, NULL, 109250, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BA', '', 'lump_sum', 1, 101200, NULL, 101200, NULL, NULL, 12, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BA', '', 'per_semester', 6, 19200, NULL, 115000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BA', 'JMC', 'annual', 3, 60170, NULL, 180500, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BA', 'JMC', 'lump_sum', 1, 167200, NULL, 167200, NULL, NULL, 12, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BA', 'JMC', 'per_semester', 6, 31700, NULL, 190000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BA', 'VERNACULAR', 'annual', 3, 30000, NULL, 90000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BA', 'VERNACULAR', 'lump_sum', 1, 90000, NULL, 90000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BBA', '', 'annual', 3, 63020, NULL, 189050, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BBA', '', 'lump_sum', 1, 175120, NULL, 175120, NULL, NULL, 12, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BBA', '', 'per_semester', 6, 33200, NULL, 199000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BBA', 'HCLTECH DATA ANALYTICS', 'annual', 3, 79170, NULL, 237500, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BBA', 'HCLTECH DATA ANALYTICS', 'lump_sum', 1, 220000, NULL, 220000, NULL, NULL, 12, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BBA', 'HCLTECH DATA ANALYTICS', 'per_semester', 6, 41700, NULL, 250000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BBA', 'KPMG BAP', 'annual', 3, 72840, NULL, 218500, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BBA', 'KPMG BAP', 'lump_sum', 1, 202400, NULL, 202400, NULL, NULL, 12, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BBA', 'KPMG BAP', 'per_semester', 6, 38400, NULL, 230000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BBA', 'LENSKART', 'annual', 3, 87090, NULL, 261250, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BBA', 'LENSKART', 'lump_sum', 1, 242000, NULL, 242000, NULL, NULL, 12, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BBA', 'LENSKART', 'per_semester', 6, 45900, NULL, 275000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BBA', 'MBA', 'annual', 3, 127560, NULL, 382660, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BBA', 'MBA', 'lump_sum', 1, 370570, NULL, 370570, NULL, NULL, 8, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BBA', 'MBA', 'per_semester', 6, 67200, NULL, 402800, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCA', '', 'annual', 3, 55420, NULL, 166250, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCA', '', 'lump_sum', 1, 154000, NULL, 154000, NULL, NULL, 12, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCA', '', 'per_semester', 6, 29200, NULL, 175000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCA', 'FINTECH', 'annual', 3, 87090, NULL, 261250, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCA', 'FINTECH', 'lump_sum', 1, 242000, NULL, 242000, NULL, NULL, 12, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCA', 'FINTECH', 'per_semester', 6, 45900, NULL, 275000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCA', 'HCLTECH DATA ENGINEERING', 'annual', 3, 79170, NULL, 237500, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCA', 'HCLTECH DATA ENGINEERING', 'lump_sum', 1, 220000, NULL, 220000, NULL, NULL, 12, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCA', 'HCLTECH DATA ENGINEERING', 'per_semester', 6, 41700, NULL, 250000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCA', 'HCLTECH SOFTWARE ENGINEERING', 'annual', 3, 79170, NULL, 237500, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCA', 'HCLTECH SOFTWARE ENGINEERING', 'lump_sum', 1, 220000, NULL, 220000, NULL, NULL, 12, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCA', 'HCLTECH SOFTWARE ENGINEERING', 'per_semester', 6, 41700, NULL, 250000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCA', 'KPMG ADE', 'annual', 3, 72840, NULL, 218500, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCA', 'KPMG ADE', 'lump_sum', 1, 202400, NULL, 202400, NULL, NULL, 12, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCA', 'KPMG ADE', 'per_semester', 6, 38400, NULL, 230000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCA', 'MCA', 'annual', 3, 112510, NULL, 337530, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCA', 'MCA', 'lump_sum', 1, 326870, NULL, 326870, NULL, NULL, 8, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCA', 'MCA', 'per_semester', 6, 59300, NULL, 355300, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCA', 'TCSION CLOUDSECURITY', 'annual', 3, 79170, NULL, 237500, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCA', 'TCSION CLOUDSECURITY', 'lump_sum', 1, 220000, NULL, 220000, NULL, NULL, 12, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCA', 'TCSION CLOUDSECURITY', 'per_semester', 6, 41700, NULL, 250000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCA', 'TCSION DATAANALYTICS', 'annual', 3, 79170, NULL, 237500, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCA', 'TCSION DATAANALYTICS', 'lump_sum', 1, 220000, NULL, 220000, NULL, NULL, 12, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCA', 'TCSION DATAANALYTICS', 'per_semester', 6, 41700, NULL, 250000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCOM', '', 'annual', 3, 36420, NULL, 109250, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCOM', '', 'lump_sum', 1, 101200, NULL, 101200, NULL, NULL, 12, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCOM', '', 'per_semester', 6, 19200, NULL, 115000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCOM', 'ACCA', 'annual', 3, 87090, NULL, 261250, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCOM', 'ACCA', 'lump_sum', 1, 242000, NULL, 242000, NULL, NULL, 12, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCOM', 'ACCA', 'per_semester', 6, 45900, NULL, 275000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCOM', 'HONS', 'annual', 3, 55420, NULL, 166250, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCOM', 'HONS', 'lump_sum', 1, 154000, NULL, 154000, NULL, NULL, 12, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCOM', 'HONS', 'per_semester', 6, 29200, NULL, 175000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCOM', 'MBA', 'annual', 3, 102290, NULL, 306850, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCOM', 'MBA', 'lump_sum', 1, 297160, NULL, 297160, NULL, NULL, 8, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCOM', 'MBA', 'per_semester', 6, 53900, NULL, 323000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCOM', 'VERNACULAR', 'annual', 3, 30000, NULL, 90000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BCOM', 'VERNACULAR', 'lump_sum', 1, 90000, NULL, 90000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'BFP', '', 'lump_sum', 1, 49000, NULL, 49000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MA', 'JMC', 'annual', 2, 90250, NULL, 180500, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MA', 'JMC', 'lump_sum', 1, 174800, NULL, 174800, NULL, NULL, 8, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MA', 'JMC', 'per_semester', 4, 47500, NULL, 190000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MA', 'PPG', 'annual', 2, 71250, NULL, 142500, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MA', 'PPG', 'lump_sum', 1, 138000, NULL, 138000, NULL, NULL, 8, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MA', 'PPG', 'per_semester', 4, 37500, NULL, 150000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MBA', '', 'annual', 2, 106880, NULL, 213750, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MBA', '', 'lump_sum', 1, 207000, NULL, 207000, NULL, NULL, 8, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MBA', '', 'per_semester', 4, 56300, NULL, 225000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MBA', 'ACCA', 'annual', 2, 156280, NULL, 312550, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MBA', 'ACCA', 'lump_sum', 1, 302680, NULL, 302680, NULL, NULL, 8, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MBA', 'ACCA', 'per_semester', 4, 82300, NULL, 329000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MBA', 'DUAL SPECIALIZATION', 'annual', 2, 156280, NULL, 312550, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MBA', 'DUAL SPECIALIZATION', 'lump_sum', 1, 302680, NULL, 302680, NULL, NULL, 8, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MBA', 'DUAL SPECIALIZATION', 'per_semester', 4, 82300, NULL, 329000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MBA', 'HHM', 'annual', 2, 156280, NULL, 312550, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MBA', 'HHM', 'lump_sum', 1, 302680, NULL, 302680, NULL, NULL, 8, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MBA', 'HHM', 'per_semester', 4, 82300, NULL, 329000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MBA', 'LENSKART', 'annual', 2, 130630, NULL, 261250, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MBA', 'LENSKART', 'lump_sum', 1, 253000, NULL, 253000, NULL, NULL, 8, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MBA', 'LENSKART', 'per_semester', 4, 68800, NULL, 275000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MCA', '', 'annual', 2, 94530, NULL, 189050, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MCA', '', 'lump_sum', 1, 183080, NULL, 183080, NULL, NULL, 8, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MCA', '', 'per_semester', 4, 49800, NULL, 199000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MCA', 'FINTECH', 'annual', 2, 130630, NULL, 261250, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MCA', 'FINTECH', 'lump_sum', 1, 253000, NULL, 253000, NULL, NULL, 8, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MCA', 'FINTECH', 'per_semester', 4, 68800, NULL, 275000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MCA', 'HCLTECH CYBERSECURITY', 'annual', 2, 130630, NULL, 261250, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MCA', 'HCLTECH CYBERSECURITY', 'lump_sum', 1, 253000, NULL, 253000, NULL, NULL, 8, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MCA', 'HCLTECH CYBERSECURITY', 'per_semester', 4, 68800, NULL, 275000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MCA', 'HCLTECH SOFTWARE ENGINEERING', 'annual', 2, 130630, NULL, 261250, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MCA', 'HCLTECH SOFTWARE ENGINEERING', 'lump_sum', 1, 253000, NULL, 253000, NULL, NULL, 8, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MCA', 'HCLTECH SOFTWARE ENGINEERING', 'per_semester', 4, 68800, NULL, 275000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MCA', 'TCSION ARVR', 'annual', 2, 130630, NULL, 261250, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MCA', 'TCSION ARVR', 'lump_sum', 1, 253000, NULL, 253000, NULL, NULL, 8, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MCA', 'TCSION ARVR', 'per_semester', 4, 68800, NULL, 275000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MCA', 'TCSION ML', 'annual', 2, 130630, NULL, 261250, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MCA', 'TCSION ML', 'lump_sum', 1, 253000, NULL, 253000, NULL, NULL, 8, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MCA', 'TCSION ML', 'per_semester', 4, 68800, NULL, 275000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MCOM', 'FM', 'annual', 2, 71250, NULL, 142500, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MCOM', 'FM', 'lump_sum', 1, 138000, NULL, 138000, NULL, NULL, 8, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MCOM', 'FM', 'per_semester', 4, 37500, NULL, 150000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MSC', 'DATASCIENCE', 'annual', 2, 130630, NULL, 261250, NULL, NULL, 5, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MSC', 'DATASCIENCE', 'lump_sum', 1, 253000, NULL, 253000, NULL, NULL, 8, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('AMI', 'online', 'MSC', 'DATASCIENCE', 'per_semester', 4, 68800, NULL, 275000, NULL, NULL, NULL, 'INR', 'xlsx:brochures/Amity/Fee Structure/July 26 Fee Structure.xlsx'),
  ('LPU', 'distance', 'BA', '', 'annual', 3, 11000, 3000, 42000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/B.A/Ba.pdf'),
  ('LPU', 'distance', 'BA', '', 'lump_sum', 1, 30000, 9000, 39000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/B.A/Ba.pdf'),
  ('LPU', 'distance', 'BA', '', 'per_semester', 6, 6000, 1500, 45000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/B.A/Ba.pdf'),
  ('LPU', 'distance', 'BBA', '', 'annual', 3, 24000, 3000, 81000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/BBA/Bba.pdf'),
  ('LPU', 'distance', 'BBA', '', 'lump_sum', 1, 69000, 9000, 78000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/BBA/Bba.pdf'),
  ('LPU', 'distance', 'BBA', '', 'per_semester', 6, 12500, 1500, 84000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/BBA/Bba.pdf'),
  ('LPU', 'distance', 'BCA', '', 'annual', 3, 24000, 3000, 81000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/BCA/Bca.pdf'),
  ('LPU', 'distance', 'BCA', '', 'lump_sum', 1, 69000, 9000, 78000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/BCA/Bca.pdf'),
  ('LPU', 'distance', 'BCA', '', 'per_semester', 6, 12500, 1500, 84000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/BCA/Bca.pdf'),
  ('LPU', 'distance', 'BCOM', '', 'annual', 3, 17000, 3000, 60000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/B.Com/Bcom.pdf'),
  ('LPU', 'distance', 'BCOM', '', 'lump_sum', 1, 48000, 9000, 57000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/B.Com/Bcom.pdf'),
  ('LPU', 'distance', 'BCOM', '', 'per_semester', 6, 9000, 1500, 63000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/B.Com/Bcom.pdf'),
  ('LPU', 'distance', 'BLIS', '', 'lump_sum', 1, 11000, 3000, 14000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/BLIS/Blis.pdf'),
  ('LPU', 'distance', 'BLIS', '', 'per_semester', 2, 6000, 1500, 15000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/BLIS/Blis.pdf'),
  ('LPU', 'distance', 'BSC', 'It', 'annual', 3, 24000, 3000, 81000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/B.Sc/Bsc_It.pdf'),
  ('LPU', 'distance', 'BSC', 'It', 'lump_sum', 1, 69000, 9000, 78000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/B.Sc/Bsc_It.pdf'),
  ('LPU', 'distance', 'BSC', 'It', 'per_semester', 6, 12500, 1500, 84000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/B.Sc/Bsc_It.pdf'),
  ('LPU', 'distance', 'DBA', '', 'lump_sum', 1, 24000, 3000, 27000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/DBA/Dba.pdf'),
  ('LPU', 'distance', 'DBA', '', 'per_semester', 2, 12500, 1500, 28000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/DBA/Dba.pdf'),
  ('LPU', 'distance', 'DCA', '', 'lump_sum', 1, 24000, 3000, 27000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/DCA/Dca.pdf'),
  ('LPU', 'distance', 'DCA', '', 'per_semester', 2, 12500, 1500, 28000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/DCA/Dca.pdf'),
  ('LPU', 'distance', 'DLIS', '', 'lump_sum', 1, 11000, 3000, 14000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/DLIS/Dlis.pdf'),
  ('LPU', 'distance', 'DLIS', '', 'per_semester', 2, 6000, 1500, 15000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/DLIS/Dlis.pdf'),
  ('LPU', 'distance', 'MA', 'Economics', 'annual', 2, 13000, 3000, 32000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.A/Ma_Economics.pdf'),
  ('LPU', 'distance', 'MA', 'Economics', 'lump_sum', 1, 24000, 6000, 30000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.A/Ma_Economics.pdf'),
  ('LPU', 'distance', 'MA', 'Economics', 'per_semester', 4, 7000, 1500, 34000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.A/Ma_Economics.pdf'),
  ('LPU', 'distance', 'MA', 'Education', 'annual', 2, 13000, 3000, 32000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.A/Ma_Education.pdf'),
  ('LPU', 'distance', 'MA', 'Education', 'lump_sum', 1, 24000, 6000, 30000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.A/Ma_Education.pdf'),
  ('LPU', 'distance', 'MA', 'Education', 'per_semester', 4, 7000, 1500, 34000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.A/Ma_Education.pdf'),
  ('LPU', 'distance', 'MA', 'English', 'annual', 2, 13000, 3000, 32000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.A/Ma_English.pdf'),
  ('LPU', 'distance', 'MA', 'English', 'lump_sum', 1, 24000, 6000, 30000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.A/Ma_English.pdf'),
  ('LPU', 'distance', 'MA', 'English', 'per_semester', 4, 7000, 1500, 34000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.A/Ma_English.pdf'),
  ('LPU', 'distance', 'MA', 'Hindi', 'annual', 2, 13000, 3000, 32000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.A/Ma_Hindi.pdf'),
  ('LPU', 'distance', 'MA', 'Hindi', 'lump_sum', 1, 24000, 6000, 30000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.A/Ma_Hindi.pdf'),
  ('LPU', 'distance', 'MA', 'Hindi', 'per_semester', 4, 7000, 1500, 34000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.A/Ma_Hindi.pdf'),
  ('LPU', 'distance', 'MA', 'History', 'annual', 2, 13000, 3000, 32000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.A/Ma_History.pdf'),
  ('LPU', 'distance', 'MA', 'History', 'lump_sum', 1, 24000, 6000, 30000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.A/Ma_History.pdf'),
  ('LPU', 'distance', 'MA', 'History', 'per_semester', 4, 7000, 1500, 34000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.A/Ma_History.pdf'),
  ('LPU', 'distance', 'MA', 'Mathematics', 'annual', 2, 13000, 3000, 32000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.A/Ma_Mathematics.pdf'),
  ('LPU', 'distance', 'MA', 'Mathematics', 'lump_sum', 1, 24000, 6000, 30000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.A/Ma_Mathematics.pdf'),
  ('LPU', 'distance', 'MA', 'Mathematics', 'per_semester', 4, 7000, 1500, 34000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.A/Ma_Mathematics.pdf'),
  ('LPU', 'distance', 'MA', 'Polscience', 'annual', 2, 13000, 3000, 32000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.A/Ma_Polscience.pdf'),
  ('LPU', 'distance', 'MA', 'Polscience', 'lump_sum', 1, 24000, 6000, 30000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.A/Ma_Polscience.pdf'),
  ('LPU', 'distance', 'MA', 'Polscience', 'per_semester', 4, 7000, 1500, 34000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.A/Ma_Polscience.pdf'),
  ('LPU', 'distance', 'MA', 'Punjabi', 'annual', 2, 13000, 3000, 32000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.A/Ma_Punjabi.pdf'),
  ('LPU', 'distance', 'MA', 'Punjabi', 'lump_sum', 1, 24000, 6000, 30000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.A/Ma_Punjabi.pdf'),
  ('LPU', 'distance', 'MA', 'Punjabi', 'per_semester', 4, 7000, 1500, 34000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.A/Ma_Punjabi.pdf'),
  ('LPU', 'distance', 'MA', 'Sociology', 'annual', 2, 13000, 3000, 32000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.A/Ma_Sociology.pdf'),
  ('LPU', 'distance', 'MA', 'Sociology', 'lump_sum', 1, 24000, 6000, 30000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.A/Ma_Sociology.pdf'),
  ('LPU', 'distance', 'MA', 'Sociology', 'per_semester', 4, 7000, 1500, 34000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.A/Ma_Sociology.pdf'),
  ('LPU', 'distance', 'MBA', '', 'annual', 2, 28000, 3000, 62000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_General.pdf'),
  ('LPU', 'distance', 'MBA', '', 'lump_sum', 1, 52000, 6000, 58000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_General.pdf'),
  ('LPU', 'distance', 'MBA', '', 'per_semester', 4, 15000, 1500, 66000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_General.pdf'),
  ('LPU', 'distance', 'MBA', 'Bankingandfinancial', 'annual', 2, 28000, 3000, 62000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Bankingandfinancial.pdf'),
  ('LPU', 'distance', 'MBA', 'Bankingandfinancial', 'lump_sum', 1, 52000, 6000, 58000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Bankingandfinancial.pdf'),
  ('LPU', 'distance', 'MBA', 'Bankingandfinancial', 'per_semester', 4, 15000, 1500, 66000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Bankingandfinancial.pdf'),
  ('LPU', 'distance', 'MBA', 'Businessanalytics', 'annual', 2, 28000, 3000, 62000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Businessanalytics.pdf'),
  ('LPU', 'distance', 'MBA', 'Businessanalytics', 'lump_sum', 1, 52000, 6000, 58000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Businessanalytics.pdf'),
  ('LPU', 'distance', 'MBA', 'Businessanalytics', 'per_semester', 4, 15000, 1500, 66000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Businessanalytics.pdf'),
  ('LPU', 'distance', 'MBA', 'Datascience', 'annual', 2, 28000, 3000, 62000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Datascience.pdf'),
  ('LPU', 'distance', 'MBA', 'Datascience', 'lump_sum', 1, 52000, 6000, 58000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Datascience.pdf'),
  ('LPU', 'distance', 'MBA', 'Datascience', 'per_semester', 4, 15000, 1500, 66000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Datascience.pdf'),
  ('LPU', 'distance', 'MBA', 'Digitalmarketing', 'annual', 2, 28000, 3000, 62000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Digitalmarketing.pdf'),
  ('LPU', 'distance', 'MBA', 'Digitalmarketing', 'lump_sum', 1, 52000, 6000, 58000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Digitalmarketing.pdf'),
  ('LPU', 'distance', 'MBA', 'Digitalmarketing', 'per_semester', 4, 15000, 1500, 66000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Digitalmarketing.pdf'),
  ('LPU', 'distance', 'MBA', 'Finance', 'annual', 2, 28000, 3000, 62000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Finance.pdf'),
  ('LPU', 'distance', 'MBA', 'Finance', 'lump_sum', 1, 52000, 6000, 58000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Finance.pdf'),
  ('LPU', 'distance', 'MBA', 'Finance', 'per_semester', 4, 15000, 1500, 66000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Finance.pdf'),
  ('LPU', 'distance', 'MBA', 'Hospitalandhealthcare', 'annual', 2, 28000, 3000, 62000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Hospitalandhealthcare.pdf'),
  ('LPU', 'distance', 'MBA', 'Hospitalandhealthcare', 'lump_sum', 1, 52000, 6000, 58000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Hospitalandhealthcare.pdf'),
  ('LPU', 'distance', 'MBA', 'Hospitalandhealthcare', 'per_semester', 4, 15000, 1500, 66000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Hospitalandhealthcare.pdf'),
  ('LPU', 'distance', 'MBA', 'Hr', 'annual', 2, 28000, 3000, 62000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Hr.pdf'),
  ('LPU', 'distance', 'MBA', 'Hr', 'lump_sum', 1, 52000, 6000, 58000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Hr.pdf'),
  ('LPU', 'distance', 'MBA', 'Hr', 'per_semester', 4, 15000, 1500, 66000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Hr.pdf'),
  ('LPU', 'distance', 'MBA', 'Informationtech', 'annual', 2, 28000, 3000, 62000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Informationtech.pdf'),
  ('LPU', 'distance', 'MBA', 'Informationtech', 'lump_sum', 1, 52000, 6000, 58000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Informationtech.pdf'),
  ('LPU', 'distance', 'MBA', 'Informationtech', 'per_semester', 4, 15000, 1500, 66000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Informationtech.pdf'),
  ('LPU', 'distance', 'MBA', 'Internationalbusiness', 'annual', 2, 28000, 3000, 62000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Internationalbusiness.pdf'),
  ('LPU', 'distance', 'MBA', 'Internationalbusiness', 'lump_sum', 1, 52000, 6000, 58000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Internationalbusiness.pdf'),
  ('LPU', 'distance', 'MBA', 'Internationalbusiness', 'per_semester', 4, 15000, 1500, 66000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Internationalbusiness.pdf'),
  ('LPU', 'distance', 'MBA', 'Logisticsandsupplychain', 'annual', 2, 28000, 3000, 62000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Logisticsandsupplychain.pdf'),
  ('LPU', 'distance', 'MBA', 'Logisticsandsupplychain', 'lump_sum', 1, 52000, 6000, 58000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Logisticsandsupplychain.pdf'),
  ('LPU', 'distance', 'MBA', 'Logisticsandsupplychain', 'per_semester', 4, 15000, 1500, 66000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Logisticsandsupplychain.pdf'),
  ('LPU', 'distance', 'MBA', 'Marketing', 'annual', 2, 28000, 3000, 62000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Marketing.pdf'),
  ('LPU', 'distance', 'MBA', 'Marketing', 'lump_sum', 1, 52000, 6000, 58000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Marketing.pdf'),
  ('LPU', 'distance', 'MBA', 'Marketing', 'per_semester', 4, 15000, 1500, 66000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Marketing.pdf'),
  ('LPU', 'distance', 'MBA', 'Operationsmanagement', 'annual', 2, 28000, 3000, 62000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Operationsmanagement.pdf'),
  ('LPU', 'distance', 'MBA', 'Operationsmanagement', 'lump_sum', 1, 52000, 6000, 58000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Operationsmanagement.pdf'),
  ('LPU', 'distance', 'MBA', 'Operationsmanagement', 'per_semester', 4, 15000, 1500, 66000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MBA/Mba_Operationsmanagement.pdf'),
  ('LPU', 'distance', 'MCA', '', 'annual', 2, 28000, 3000, 62000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MCA/Mca_General.pdf'),
  ('LPU', 'distance', 'MCA', '', 'lump_sum', 1, 52000, 6000, 58000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MCA/Mca_General.pdf'),
  ('LPU', 'distance', 'MCA', '', 'per_semester', 4, 15000, 1500, 66000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MCA/Mca_General.pdf'),
  ('LPU', 'distance', 'MCOM', '', 'annual', 2, 17000, 3000, 40000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.COM/Mcom.pdf'),
  ('LPU', 'distance', 'MCOM', '', 'lump_sum', 1, 32000, 6000, 38000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.COM/Mcom.pdf'),
  ('LPU', 'distance', 'MCOM', '', 'per_semester', 4, 9000, 1500, 42000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.COM/Mcom.pdf'),
  ('LPU', 'distance', 'MLIS', '', 'lump_sum', 1, 11000, 3000, 14000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MLIS/Mlis.pdf'),
  ('LPU', 'distance', 'MLIS', '', 'per_semester', 2, 6000, 1500, 15000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/MLIS/Mlis.pdf'),
  ('LPU', 'distance', 'MSC', 'It', 'annual', 2, 28000, 3000, 62000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.Sc/Msc_It.pdf'),
  ('LPU', 'distance', 'MSC', 'It', 'lump_sum', 1, 52000, 6000, 58000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.Sc/Msc_It.pdf'),
  ('LPU', 'distance', 'MSC', 'It', 'per_semester', 4, 15000, 1500, 66000, 600, 1200, NULL, 'INR', 'brochure:brochures/LPU - Distance/M.Sc/Msc_It.pdf'),
  ('LPU', 'online', 'BA', '', 'per_semester', 6, 18000, 2000, 120000, 600, NULL, 20, 'INR', 'brochure:brochures/LPU/B.A/Ba_General.pdf'),
  ('LPU', 'online', 'BBA', '', 'per_semester', 6, 23000, 2000, 150000, 600, NULL, 20, 'INR', 'brochure:brochures/LPU/BBA/Bba_General.pdf'),
  ('LPU', 'online', 'BCA', '', 'per_semester', 6, 23000, 2000, 150000, 600, NULL, 20, 'INR', 'brochure:brochures/LPU/BCA/Bca_General.pdf'),
  ('LPU', 'online', 'MA', '', 'per_semester', 4, 18000, 2000, 80000, 600, NULL, 20, 'INR', 'brochure:brochures/LPU/MA/Ma_General.pdf'),
  ('LPU', 'online', 'MA', 'English', 'per_semester', 4, 18000, 2000, 80000, 600, NULL, 20, 'INR', 'brochure:brochures/LPU/MA/Ma_English.pdf'),
  ('LPU', 'online', 'MA', 'History', 'per_semester', 4, 18000, 2000, 80000, 600, NULL, 20, 'INR', 'brochure:brochures/LPU/MA/Ma_History.pdf'),
  ('LPU', 'online', 'MA', 'Polscience', 'per_semester', 4, 18000, 2000, 80000, 600, NULL, 20, 'INR', 'brochure:brochures/LPU/MA/Ma_Polscience.pdf'),
  ('LPU', 'online', 'MA', 'Sociology', 'per_semester', 4, 18000, 2000, 80000, 600, NULL, 20, 'INR', 'brochure:brochures/LPU/MA/Ma_Sociology.pdf'),
  ('LPU', 'online', 'MBA', '', 'per_semester', 4, 48000, 2000, 200000, 600, NULL, 20, 'INR', 'brochure:brochures/LPU/MBA/Mba_General.pdf'),
  ('LPU', 'online', 'MBA', 'Bankingandfinancial', 'per_semester', 4, 48000, 2000, 200000, 600, NULL, 20, 'INR', 'brochure:brochures/LPU/MBA/Mba_Bankingandfinancial.pdf'),
  ('LPU', 'online', 'MBA', 'Businessanalytics', 'per_semester', 4, 48000, 2000, 200000, 600, NULL, 20, 'INR', 'brochure:brochures/LPU/MBA/Mba_Businessanalytics.pdf'),
  ('LPU', 'online', 'MBA', 'Datascience', 'per_semester', 4, 48000, 2000, 200000, 600, NULL, 20, 'INR', 'brochure:brochures/LPU/MBA/Mba_Datascience.pdf'),
  ('LPU', 'online', 'MBA', 'Digitalmarketing', 'per_semester', 4, 48000, 2000, 200000, 600, NULL, 20, 'INR', 'brochure:brochures/LPU/MBA/Mba_Digitalmarketing.pdf'),
  ('LPU', 'online', 'MBA', 'Finance', 'per_semester', 4, 48000, 2000, 200000, 600, NULL, 20, 'INR', 'brochure:brochures/LPU/MBA/Mba_Finance.pdf'),
  ('LPU', 'online', 'MBA', 'Hospitalandhealthcare', 'per_semester', 4, 48000, 2000, 200000, 600, NULL, 20, 'INR', 'brochure:brochures/LPU/MBA/Mba_Hospitalandhealthcare.pdf'),
  ('LPU', 'online', 'MBA', 'Hr', 'per_semester', 4, 48000, 2000, 200000, 600, NULL, 20, 'INR', 'brochure:brochures/LPU/MBA/Mba_Hr.pdf'),
  ('LPU', 'online', 'MBA', 'Informationtech', 'per_semester', 4, 48000, 2000, 200000, 600, NULL, 20, 'INR', 'brochure:brochures/LPU/MBA/Mba_Informationtech.pdf'),
  ('LPU', 'online', 'MBA', 'Internationalbusiness', 'per_semester', 4, 48000, 2000, 200000, 600, NULL, 20, 'INR', 'brochure:brochures/LPU/MBA/Mba_Internationalbusiness.pdf'),
  ('LPU', 'online', 'MBA', 'Logisticsandsupplychain', 'per_semester', 4, 48000, 2000, 200000, 600, NULL, 20, 'INR', 'brochure:brochures/LPU/MBA/Mba_Logisticsandsupplychain.pdf'),
  ('LPU', 'online', 'MBA', 'Marketing', 'per_semester', 4, 48000, 2000, 200000, 600, NULL, 20, 'INR', 'brochure:brochures/LPU/MBA/Mba_Marketing.pdf'),
  ('LPU', 'online', 'MBA', 'Operationsmanagement', 'per_semester', 4, 48000, 2000, 200000, 600, NULL, 20, 'INR', 'brochure:brochures/LPU/MBA/Mba_Operationsmanagement.pdf'),
  ('LPU', 'online', 'MCA', '', 'per_semester', 4, 35000, 2000, 148000, 600, NULL, NULL, 'INR', 'brochure:brochures/LPU/MCA/Mca_General.pdf'),
  ('LPU', 'online', 'MCA', 'Arvr', 'per_semester', 4, 35000, 2000, 148000, 600, NULL, NULL, 'INR', 'brochure:brochures/LPU/MCA/Mca_Arvr.pdf'),
  ('LPU', 'online', 'MCA', 'Cybersecurity', 'per_semester', 4, 35000, 2000, 148000, 600, NULL, NULL, 'INR', 'brochure:brochures/LPU/MCA/Mca_Cybersecurity.pdf'),
  ('LPU', 'online', 'MCA', 'Datascience', 'per_semester', 4, 33000, 2000, 140000, 600, NULL, NULL, 'INR', 'brochure:brochures/LPU/MCA/Mca_Datascience.pdf'),
  ('LPU', 'online', 'MCA', 'Fullstackdevelopment', 'per_semester', 4, 35000, 2000, 148000, 600, NULL, NULL, 'INR', 'brochure:brochures/LPU/MCA/Mca_Fullstackdevelopment.pdf'),
  ('LPU', 'online', 'MCA', 'Mlandai', 'per_semester', 4, 33000, 2000, 140000, 600, NULL, NULL, 'INR', 'brochure:brochures/LPU/MCA/Mca_Mlandai.pdf'),
  ('LPU', 'online', 'MCOM', '', 'per_semester', 4, 23000, 2000, 100000, 600, NULL, 20, 'INR', 'brochure:brochures/LPU/M.COM/Mcom_General.pdf'),
  ('LPU', 'online', 'MSC', 'Economics', 'per_semester', 4, 18000, 2000, 80000, 600, NULL, NULL, 'INR', 'brochure:brochures/LPU/M.Sc/Msc_Economics.pdf'),
  ('LPU', 'online', 'MSC', 'Mathematics', 'per_semester', 4, 18000, 2000, 80000, 600, NULL, NULL, 'INR', 'brochure:brochures/LPU/M.Sc/Msc_Mathematics.pdf')
) AS v(university, mode, program, specialization, payment_option,
       term_count, programme_fee, exam_fee, total_fee, application_fee,
       study_material_fee, list_discount_pct, currency, source)
WHERE NOT EXISTS (
  SELECT 1 FROM fee_templates t
  WHERE t.account_id = a.id
    AND t.university = v.university
    AND t.mode = v.mode
    AND t.program = v.program
    AND t.specialization = v.specialization
    AND t.payment_option = v.payment_option::fee_payment_option_enum
    AND t.variant = ''
    AND t.effective_from = DATE '2026-07-01'
);
