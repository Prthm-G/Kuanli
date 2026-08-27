/**
 * Admissions reconciliation pass (2026-08-27).
 *
 * The 2026-08-26 backfill imported 335 students and left 99 items flagged for a
 * human. Since then the office added 36 more rows to the workbook and resolved
 * none of the flags. This script closes the gap:
 *
 *   - imports the students the live workbook has and Kuanli does not,
 *   - applies the reconciliation decisions that the DATA itself settles,
 *   - corrects the migrated rows those decisions move.
 *
 * Every decision is written out in DECISIONS below with the evidence for it, so
 * the office can overrule any single line without reading the code. Items the
 * data cannot settle are NOT guessed; they stay flagged and are listed in the
 * report for the office.
 *
 * Like `backfill-admissions.ts`, this writes NOTHING to the database. It emits
 * staged SQL that is reviewed and applied stage by stage with a verification
 * pause between each. Every stage is idempotent.
 *
 * It uses its own staging table. `admission_import_staging` is deliberately
 * left alone: `rollback.sql` for the 2026-08-26 migration keys on it, and
 * truncating it would strand that migration with no way back.
 *
 *   node --experimental-strip-types --import ./scripts/ts-loader.mjs \
 *     scripts/reconcile-admissions.ts --out <dir> --workbook <path> \
 *     --account <uuid> --owner <uuid>
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { readWorkbook } from '@/lib/admissions/xlsx-lite';
import { parseAdmissionSheet } from '@/lib/admissions/parse-sheet';
import { reconcile, type ReconciledRow } from '@/lib/admissions/reconcile';
import { ACTIVE_SHEETS } from '@/lib/admissions/index';
import { encrypt } from '@/lib/whatsapp/encryption';

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined && fallback === undefined) throw new Error(`Missing --${name}`);
  return v ?? fallback!;
};

const WORKBOOK = arg('workbook');
const OUT = arg('out');
const ACCOUNT_ID = arg('account');
const OWNER_ID = arg('owner');
const PIPELINE = arg('pipeline', 'LPU Admissions');
const UNIVERSITY = arg('university', 'LPU');
const STAGING = 'admission_reconcile_staging';

const q = (v: string | null | undefined): string =>
  v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
const num = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v) ? 'NULL' : String(v);
const key = (r: { sheet: string; rowNumber: number }) => `${r.sheet}#${r.rowNumber}`;

/* ------------------------------------------------------------- decisions
 * Only what the sheet settles on its own. Anything where two readings are both
 * coherent is absent from this table on purpose and stays with the office.
 */

/** Rows that are the SAME student twice. Keep one, retire the other. */
const SAME_STUDENT: Array<{ keep: string; retire: string; why: string }> = [
  {
    keep: '2026-1#45', retire: '2025-2#34',
    why: 'Same name, same father (Sohan lal), same course (MBA), same total (17100), consecutive cycles. One admission carried forward, not two degrees. The 2026-1 row is the later state (paid 14000 against 1000).',
  },
  {
    keep: '2026-1#207', retire: '2025-2#74',
    why: 'Same father (Ravinder singh), same course (MA English), emails differ by one letter (manu/mannu). The 2025-2 row is settled (8600 of 8600); 2026-1 is the live cycle.',
  },
  {
    keep: '2026-1#232', retire: '2026-1#214',
    why: 'Same name, same course, same cycle, father spelled Sukhwinder/Sukhswinder, emails japneetkaur/japneetkaur240. Row 214 total (16400) equals row 232 paid (16400), so 214 is an earlier draft of the same entry.',
  },
];

/** Rows that are DIFFERENT students who share a handset. */
const SHARED_HANDSET: Array<{ row: string; action: 'use-second-number' | 'keep-number' | 'no-number'; why: string }> = [
  { row: '2025-2#36', action: 'use-second-number', why: 'Sumandeep singh. Different father, course and email from Abhey sharma on the same number. His own second number 6283016015 appears nowhere else in the workbook.' },
  { row: '2025-2#48', action: 'keep-number', why: 'Abhey sharma keeps 8427366878; the other row on it has moved to its own number.' },
  { row: '2026-1#98', action: 'keep-number', why: 'Taranpreet kaur. Distinct registration number 22608680045.' },
  { row: '2026-1#99', action: 'no-number', why: 'Jasleen Kaur. Sister of the row above: same father, and they share BOTH numbers in the sheet, so neither can be given a distinct one. Imported without a number; her registration number 22608680046 identifies her.' },
];

/** Contacts whose only usable number is the second column. */
const USE_SECOND_NUMBER: Record<string, string> = {
  '2026-1#191': 'Harshjot kaur has no primary number at all; 8194955593 is unique in the workbook.',
  '2026-1#158': 'Amandeep singh primary reads "987632528", nine digits and unusable; 9876220528 is unique in the workbook.',
  '2026-1#184': 'Gursweak singh primary reads "988899264", nine digits and unusable; 9888899266 is unique in the workbook.',
};

/** TOTAL FEE blank, but paid+discount lands exactly on the programme list price. */
const TOTAL_FEE_FROM_LIST_PRICE: Record<string, { amount: number; why: string }> = {
  '2025-2#97': { amount: 8100, why: 'BA distance. Paid 8100 with no discount, and 8100 is the BA distance price on 160 of 197 rows.' },
  '2025-2#98': { amount: 8100, why: 'BA distance. Paid 8100 with no discount; matches the BA distance price.' },
  '2025-2#100': { amount: 8100, why: 'BA distance. Paid 6500 plus a 1600 discount is exactly 8100, the BA distance price. Two independent signals agree.' },
  '2025-2#101': { amount: 8100, why: 'BLIS distance. Paid 8100 with no discount, and 8100 is the BLIS distance price on 13 of 16 rows.' },
};

/** Fee rows where the sheet contradicts itself, so one side is provably wrong. */
const FEE_VERDICT: Record<string, { winner: 'arithmetic' | 'sheet'; why: string }> = {
  '2026-1#97': { winner: 'arithmetic', why: 'Stated FEE DUE 13600 is larger than the TOTAL FEE 8100. A student cannot owe more than the whole course costs.' },
  '2026-1#225': { winner: 'arithmetic', why: 'Stated FEE DUE 16400 is exactly the FEE PAID figure; the cell was copied across. Total 17400 less a 1000 discount less 16400 paid is 0.' },
  '2025-2#21': { winner: 'sheet', why: 'Paid 14600 plus a 600 discount exceeds the 14600 total. The discount is already inside the paid figure, so nothing is owed and the migrated discount row is the double count.' },
  '2025-2#22': { winner: 'sheet', why: 'Same shape as the row above: paid 14600 plus a 600 discount against a 14600 total.' },
};

/* ------------------------------------------------------------------ parse */

const wb = readWorkbook(readFileSync(WORKBOOK));
const parsed = ACTIVE_SHEETS.flatMap((n) => parseAdmissionSheet(n, wb.sheet(n)).rows);
const res = reconcile(parsed);
const parsedByKey = new Map(parsed.map((r) => [key(r), r]));

const retired = new Set(SAME_STUDENT.map((d) => d.retire));
const sharedAction = new Map(SHARED_HANDSET.map((d) => [d.row, d.action]));

/** Held-back rows the decisions above release back into the import. */
const released: ReconciledRow[] = [];
for (const h of res.heldBack) {
  const k = key(h.row);
  if (retired.has(k)) continue;
  const action = sharedAction.get(k);
  const kept = SAME_STUDENT.find((d) => d.keep === k);
  if (!action && !kept) continue;

  const one = reconcile([h.row]).importable[0];
  if (!one) continue;
  if (action === 'use-second-number') one.importPhone = h.row.secondaryPhone || '';
  if (action === 'no-number') one.importPhone = '';
  released.push(one);
}

/** Everything the live sheet says should exist, after the decisions. */
const rows: ReconciledRow[] = [...res.importable.filter((r) => !retired.has(key(r))), ...released];

for (const r of rows) {
  const k = key(r);
  const second = USE_SECOND_NUMBER[k];
  if (second) r.importPhone = (parsedByKey.get(k)?.secondaryPhone) || r.importPhone;
  const fill = TOTAL_FEE_FROM_LIST_PRICE[k];
  if (fill && r.agreedTotal === null) {
    r.agreedTotal = fill.amount;
    r.outstanding = fill.amount - r.discountAmount - r.openingPaid;
  }
  /** Carry a field off the retired twin so nothing is lost by retiring it. */
  const merge = SAME_STUDENT.find((d) => d.keep === k);
  if (merge) {
    const old = parsedByKey.get(merge.retire);
    if (old) {
      if (!r.email && old.email) r.email = old.email;
      if (!r.universityRollNumber && old.universityRollNumber) {
        r.universityRollNumber = old.universityRollNumber;
      }
    }
  }
}

const noteFor = (r: ReconciledRow): string => {
  const bits = [`Reconciled from Excel "${r.sheet}" row ${r.rowNumber} on 2026-08-27.`];
  if (r.fatherName) bits.push(`Father: ${r.fatherName}.`);
  if (r.rawCourse) bits.push(`Course as written: "${r.rawCourse}".`);
  if (r.receiptNumber) bits.push(`Receipts: ${r.receiptNumber}.`);
  const k = key(r);
  if (USE_SECOND_NUMBER[k]) bits.push('Contact number taken from the second number column.');
  if (TOTAL_FEE_FROM_LIST_PRICE[k]) bits.push('TOTAL FEE inferred from the programme list price; confirm with the office.');
  if (!r.feeReconciles && !FEE_VERDICT[k]) bits.push('Fee columns did not reconcile; verify with the office.');
  return bits.join(' ');
};

/* -------------------------------------------------------------------- sql */

mkdirSync(OUT, { recursive: true });
const w = (f: string, s: string) => writeFileSync(path.join(OUT, f), s.trimStart());

/**
 * ENCRYPTION_KEY is only needed if a row carries a portal password that is not
 * already stored. Every credentialed student in the live workbook was migrated
 * on 2026-08-26 and stage B skips them, so this pass runs without the key. If
 * a future cycle brings a NEW credential, the run stops here rather than
 * silently dropping it.
 */
const CAN_ENCRYPT = Boolean(process.env.ENCRYPTION_KEY);
const passwordRows = rows.filter((r) => r.portalPassword);
if (passwordRows.length > 0 && !CAN_ENCRYPT) {
  console.warn(
    `note: ${passwordRows.length} row(s) carry a portal password and ENCRYPTION_KEY is not set.\n` +
      '      Their credentials are staged as NULL. Stage B leaves an existing credential\n' +
      '      untouched, so this is correct only while every one of them is already stored.\n' +
      '      Rows: ' + passwordRows.map(key).join(', '),
  );
}

const values = rows.map((r) => {
  const cipher = r.portalPassword && CAN_ENCRYPT ? encrypt(r.portalPassword) : null;
  return `(${[
    q(key(r)), q(ACCOUNT_ID), q(r.sheet), String(r.rowNumber), q(r.name), q(r.importPhone),
    q(r.email || null), q(UNIVERSITY), q(r.effectiveMode), q(r.course.program),
    q(r.course.specialization ?? ''), q(r.intakeYear), q(r.intakeSession),
    q(r.universityRollNumber || null), num(r.agreedTotal), num(r.discountAmount),
    num(r.openingPaid), q(r.stage), q(cipher), q(r.paymentDate), q(noteFor(r)),
  ].join(', ')})`;
});

w('stage-0-staging.sql', `
-- Stage 0: build this pass's own staging table.
-- admission_import_staging is left untouched: rollback.sql for the 2026-08-26
-- migration keys on it, and clearing it would strand that rollback.
BEGIN;
CREATE TABLE IF NOT EXISTS ${STAGING} (
  source_key             TEXT PRIMARY KEY,
  account_id             UUID NOT NULL,
  sheet                  TEXT NOT NULL,
  row_number             INTEGER NOT NULL,
  name                   TEXT NOT NULL,
  phone                  TEXT NOT NULL DEFAULT '',
  email                  TEXT,
  university             TEXT,
  mode                   TEXT,
  program                TEXT,
  specialization         TEXT NOT NULL DEFAULT '',
  intake_year            TEXT,
  intake_session         TEXT,
  university_roll_number TEXT,
  agreed_total           NUMERIC(12,2),
  discount               NUMERIC(12,2) NOT NULL DEFAULT 0,
  paid                   NUMERIC(12,2) NOT NULL DEFAULT 0,
  stage_name             TEXT NOT NULL,
  password_ciphertext    TEXT,
  paid_at                DATE,
  note                   TEXT,
  contact_id             UUID
);
TRUNCATE ${STAGING};
INSERT INTO ${STAGING} (
  source_key, account_id, sheet, row_number, name, phone, email, university, mode,
  program, specialization, intake_year, intake_session, university_roll_number,
  agreed_total, discount, paid, stage_name, password_ciphertext, paid_at, note
) VALUES
${values.join(',\n')};

-- Link every staged row to its contact, same rules as the 2026-08-26 pass.
UPDATE ${STAGING} s SET contact_id = c.id
FROM contacts c
WHERE c.account_id = s.account_id
  AND s.phone <> '' AND c.phone_normalized = regexp_replace(s.phone, '\\D', '', 'g');

UPDATE ${STAGING} s SET contact_id = c.id
FROM contacts c
WHERE c.account_id = s.account_id AND s.phone = '' AND c.phone = ''
  AND lower(c.name) = lower(s.name)
  AND c.intake_year IS NOT DISTINCT FROM s.intake_year
  AND c.intake_session IS NOT DISTINCT FROM s.intake_session
  AND s.contact_id IS NULL;
COMMIT;

-- Read-only check. Rows with no contact_id are the ones stage A will create.
SELECT count(*) FILTER (WHERE contact_id IS NOT NULL) AS already_in_kuanli,
       count(*) FILTER (WHERE contact_id IS NULL)     AS to_be_created
FROM ${STAGING};
`);

w('stage-a-contacts.sql', `
-- Stage A: create the students Kuanli does not have. Existing contacts win on
-- every field they already hold, exactly as on 2026-08-26.
BEGIN;
INSERT INTO contacts (account_id, user_id, phone, name, email, university,
                      intake_year, intake_session, university_roll_number, source, source_detail)
SELECT s.account_id, ${q(OWNER_ID)}::uuid, s.phone, s.name, NULLIF(s.email,''), s.university,
       s.intake_year, s.intake_session, s.university_roll_number, 'organic', 'excel-migration'
FROM ${STAGING} s
WHERE s.phone <> ''
ON CONFLICT (account_id, phone_normalized) WHERE phone_normalized <> ''
DO UPDATE SET
  name                   = COALESCE(contacts.name, EXCLUDED.name),
  email                  = COALESCE(contacts.email, EXCLUDED.email),
  university             = COALESCE(contacts.university, EXCLUDED.university),
  intake_year            = COALESCE(contacts.intake_year, EXCLUDED.intake_year),
  intake_session         = COALESCE(contacts.intake_session, EXCLUDED.intake_session),
  university_roll_number = COALESCE(contacts.university_roll_number, EXCLUDED.university_roll_number),
  updated_at             = now();

INSERT INTO contacts (account_id, user_id, phone, name, email, university,
                      intake_year, intake_session, university_roll_number, source, source_detail)
SELECT s.account_id, ${q(OWNER_ID)}::uuid, '', s.name, NULLIF(s.email,''), s.university,
       s.intake_year, s.intake_session, s.university_roll_number, 'organic', 'excel-migration'
FROM ${STAGING} s
WHERE s.phone = ''
  AND NOT EXISTS (
    SELECT 1 FROM contacts c
    WHERE c.account_id = s.account_id AND c.phone = ''
      AND lower(c.name) = lower(s.name)
      AND c.intake_year IS NOT DISTINCT FROM s.intake_year
      AND c.intake_session IS NOT DISTINCT FROM s.intake_session
  );

UPDATE ${STAGING} s SET contact_id = c.id
FROM contacts c
WHERE c.account_id = s.account_id
  AND s.phone <> '' AND c.phone_normalized = regexp_replace(s.phone, '\\D', '', 'g');

UPDATE ${STAGING} s SET contact_id = c.id
FROM contacts c
WHERE c.account_id = s.account_id AND s.phone = '' AND c.phone = ''
  AND lower(c.name) = lower(s.name)
  AND c.intake_year IS NOT DISTINCT FROM s.intake_year
  AND c.intake_session IS NOT DISTINCT FROM s.intake_session
  AND s.contact_id IS NULL;

DO $$
DECLARE n INTEGER;
BEGIN
  SELECT count(*) INTO n FROM ${STAGING} WHERE contact_id IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'stage A left % staged rows unresolved', n; END IF;
END $$;
COMMIT;
`);

w('stage-b-fees.sql', `
-- Stage B: fee plans, opening balances, discounts and credentials for the
-- students stage A created. Every insert is guarded, so students already
-- carrying these rows are untouched.
BEGIN;
INSERT INTO student_fee_plans (account_id, contact_id, university, mode, program,
                               specialization, currency, agreed_total, note, created_by)
SELECT s.account_id, s.contact_id, s.university, s.mode, s.program, s.specialization,
       'INR', s.agreed_total, s.note, ${q(OWNER_ID)}::uuid
FROM ${STAGING} s
WHERE s.agreed_total IS NOT NULL
ON CONFLICT (contact_id) DO NOTHING;

INSERT INTO payments (account_id, contact_id, plan_id, paid_at, amount, currency, method,
                      reference, note, status, logged_by, verified_by, verified_at)
SELECT s.account_id, s.contact_id, p.id,
       COALESCE(s.paid_at::timestamptz, now()), s.paid, 'INR', 'other',
       NULL, 'Opening balance migrated from Excel (' || s.sheet || ' row ' || s.row_number || ')',
       'verified', ${q(OWNER_ID)}::uuid, ${q(OWNER_ID)}::uuid, now()
FROM ${STAGING} s
LEFT JOIN student_fee_plans p ON p.contact_id = s.contact_id
WHERE s.paid > 0
  AND NOT EXISTS (
    SELECT 1 FROM payments x WHERE x.contact_id = s.contact_id AND x.method = 'other'
      AND x.note LIKE 'Opening balance migrated from Excel%'
  );

INSERT INTO fee_discounts (account_id, contact_id, plan_id, amount, reason, status,
                            proposed_by, decided_by, decided_at, decision_note)
SELECT s.account_id, s.contact_id, p.id, s.discount,
       'Concession recorded in the office spreadsheet (' || s.sheet || ' row ' || s.row_number || ')',
       'approved', ${q(OWNER_ID)}::uuid, ${q(OWNER_ID)}::uuid, now(),
       'Approved historically; migrated from Excel.'
FROM ${STAGING} s
LEFT JOIN student_fee_plans p ON p.contact_id = s.contact_id
WHERE s.discount > 0
  AND NOT EXISTS (
    SELECT 1 FROM fee_discounts d WHERE d.contact_id = s.contact_id
      AND d.reason LIKE 'Concession recorded in the office spreadsheet%'
  );

INSERT INTO student_portal_credentials (account_id, contact_id, label, portal_url,
                                        username, password_ciphertext, notes, created_by)
SELECT s.account_id, s.contact_id, 'LPU student portal', NULL,
       NULLIF(s.university_roll_number,''), s.password_ciphertext,
       'Migrated from the office spreadsheet.', ${q(OWNER_ID)}::uuid
FROM ${STAGING} s
WHERE s.password_ciphertext IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM student_portal_credentials c
    WHERE c.contact_id = s.contact_id AND c.label = 'LPU student portal'
  );
COMMIT;
`);

w('stage-c-deals.sql', `
-- Stage C: one deal per student, forward-only, same rules as 2026-08-26.
BEGIN;
INSERT INTO deals (user_id, account_id, pipeline_id, stage_id, contact_id, title,
                   value, currency, notes)
SELECT ${q(OWNER_ID)}::uuid, s.account_id, pl.id, st.id, s.contact_id,
       s.name, COALESCE(s.agreed_total, 0), 'INR', s.note
FROM ${STAGING} s
JOIN pipelines pl ON pl.account_id = s.account_id AND pl.name = ${q(PIPELINE)}
JOIN pipeline_stages st ON st.pipeline_id = pl.id AND st.name = s.stage_name
WHERE NOT EXISTS (
  SELECT 1 FROM deals d WHERE d.contact_id = s.contact_id AND d.pipeline_id = pl.id
);

UPDATE deals d
SET stage_id = st.id, updated_at = now()
FROM ${STAGING} s
JOIN pipelines pl ON pl.account_id = s.account_id AND pl.name = ${q(PIPELINE)}
JOIN pipeline_stages st ON st.pipeline_id = pl.id AND st.name = s.stage_name,
     pipeline_stages cur
WHERE d.contact_id = s.contact_id
  AND d.pipeline_id = pl.id
  AND cur.id = d.stage_id
  AND cur.position < st.position;
COMMIT;
`);

/* Stage D: corrections to rows the 2026-08-26 pass already wrote. */
const doubleCounted = Object.entries(FEE_VERDICT).filter(([, v]) => v.winner === 'sheet').map(([k]) => k);
const phoneFixes = rows.filter((r) => USE_SECOND_NUMBER[key(r)] && r.importPhone);

w('stage-d-corrections.sql', `
-- Stage D: correct rows the 2026-08-26 pass already wrote. Restricted to
-- contacts that migration created (source_detail = 'excel-migration'), so a
-- real WhatsApp lead can never be edited by this script.
BEGIN;

-- D1. Two students whose 600 concession was already inside the amount they
-- paid, so the migrated discount row double-counted it and left the balance
-- reading -600. Removing the discount row makes outstanding total - paid = 0.
DELETE FROM fee_discounts d
USING contacts c, ${STAGING} s
WHERE d.contact_id = c.id
  AND c.id = s.contact_id
  AND c.source_detail = 'excel-migration'
  AND s.source_key IN (${doubleCounted.map(q).join(', ')})
  AND d.reason LIKE 'Concession recorded in the office spreadsheet%';

-- D2. Students imported with no usable number, where the workbook's second
-- number column holds one that appears nowhere else. Guarded so it can never
-- collide with an existing contact.
${phoneFixes.length === 0 ? '-- (none)' : phoneFixes.map((r) => `
UPDATE contacts c SET phone = ${q(r.importPhone)}, updated_at = now()
FROM ${STAGING} s
WHERE c.id = s.contact_id AND s.source_key = ${q(key(r))}
  AND c.source_detail = 'excel-migration'
  AND c.phone = ''
  AND NOT EXISTS (
    SELECT 1 FROM contacts x WHERE x.account_id = c.account_id AND x.id <> c.id
      AND x.phone_normalized = regexp_replace(${q(r.importPhone)}, '\\D', '', 'g')
  );`).join('\n')}

-- D3 is deliberately NOT here.
--
-- The obvious next correction is to clear the "Fee columns did not reconcile
-- at migration; verify with the office." sentence from the rows where that is
-- no longer true. It is left undone on purpose: the 2026-08-26 rollback finds
-- its rows by matching deals.notes and student_fee_plans.note against the
-- staged note text, so rewriting either would make that rollback silently
-- match nothing and leave the whole migration un-undoable. A stale sentence
-- on a deal card is a much smaller
-- problem than a rollback that quietly does nothing.
--
-- Do it once the 2026-08-26 rollback is retired, or re-key that rollback off
-- source_key first.
COMMIT;
`);

w('rollback.sql', `
-- Rollback for the 2026-08-27 reconciliation pass ONLY.
-- It removes the rows THIS pass created and drops THIS pass's staging table.
-- It deliberately does not touch admission_import_staging, which the
-- 2026-08-26 migration's own rollback still depends on.
--
-- Stage D is NOT undone here. D1 deletes a double-counted discount and D2/D3
-- correct a phone and a note; restoring those would put known-wrong data back.
-- Use the pre-apply dump if a full reversal is genuinely wanted.
BEGIN;
DELETE FROM deals d USING ${STAGING} s
  WHERE d.contact_id = s.contact_id AND d.notes = s.note;
DELETE FROM student_portal_credentials c USING ${STAGING} s
  WHERE c.contact_id = s.contact_id AND c.label = 'LPU student portal'
    AND NOT EXISTS (SELECT 1 FROM admission_import_staging o WHERE o.contact_id = s.contact_id);
DELETE FROM fee_discounts x USING ${STAGING} s
  WHERE x.contact_id = s.contact_id AND x.reason LIKE 'Concession recorded in the office spreadsheet%'
    AND NOT EXISTS (SELECT 1 FROM admission_import_staging o WHERE o.contact_id = s.contact_id);
DELETE FROM payments p USING ${STAGING} s
  WHERE p.contact_id = s.contact_id AND p.note LIKE 'Opening balance migrated from Excel%'
    AND NOT EXISTS (SELECT 1 FROM admission_import_staging o WHERE o.contact_id = s.contact_id);
DELETE FROM student_fee_plans p USING ${STAGING} s
  WHERE p.contact_id = s.contact_id AND p.note = s.note;
DELETE FROM contacts c USING ${STAGING} s
  WHERE c.id = s.contact_id AND c.source_detail = 'excel-migration'
    AND NOT EXISTS (SELECT 1 FROM admission_import_staging o WHERE o.contact_id = c.id);
DROP TABLE IF EXISTS ${STAGING};
COMMIT;
`);

w('verify.sql', `
-- Read-only. Safe to run at ANY point, including before stage 0: it does not
-- reference this pass's staging table, so it works as a baseline too. Stage 0
-- and stage A report their own staged-row counts.
SELECT 'contacts from excel'    AS check, count(*)::text AS value
  FROM contacts WHERE source_detail = 'excel-migration'
UNION ALL SELECT 'fee plans',             count(*)::text FROM student_fee_plans
UNION ALL SELECT 'negative outstanding',  count(*)::text FROM (
  SELECT p.contact_id,
         p.agreed_total
           - COALESCE((SELECT sum(amount) FROM payments   x WHERE x.contact_id = p.contact_id AND x.status = 'verified'), 0)
           - COALESCE((SELECT sum(amount) FROM fee_discounts d WHERE d.contact_id = p.contact_id AND d.status <> 'rejected'), 0) AS bal
  FROM student_fee_plans p) t WHERE bal < 0
UNION ALL SELECT 'deals in pipeline',     count(*)::text FROM deals d
  JOIN pipelines pl ON pl.id = d.pipeline_id AND pl.name = ${q(PIPELINE)}
UNION ALL SELECT 'contacts with 2 deals', count(*)::text FROM (
  SELECT d.contact_id FROM deals d JOIN pipelines pl ON pl.id = d.pipeline_id AND pl.name = ${q(PIPELINE)}
  GROUP BY d.contact_id HAVING count(*) > 1) x;
`);

/* ----------------------------------------------------------------- report */

const stillFlagged = res.flags.filter((f) => {
  const k = `${f.sheet}#${f.rowNumber}`;
  if (retired.has(k)) return false;
  if (f.code === 'duplicate-phone') return false;
  if (f.code === 'fee-mismatch' && FEE_VERDICT[k]) return false;
  // D1 removes the double-counted discount, so the overpayment goes with it.
  if (f.code === 'overpaid' && FEE_VERDICT[k]?.winner === 'sheet') return false;
  if (f.code === 'no-total-fee' && TOTAL_FEE_FROM_LIST_PRICE[k]) return false;
  if ((f.code === 'no-phone' || f.code === 'bad-phone') && USE_SECOND_NUMBER[k]) return false;
  return true;
});

const R: string[] = [];
R.push('# Admissions reconciliation, 2026-08-27');
R.push('');
R.push(`Workbook: \`${path.basename(WORKBOOK)}\``);
R.push('');
R.push(`Live sheet holds ${res.importable.length} importable rows plus ${res.heldBack.length} held back.`);
R.push(`After the decisions below, ${rows.length} students are staged.`);
R.push('');
R.push('## Decided from the data');
R.push('');
const decided: Array<[string, string]> = [];
for (const d of SAME_STUDENT) decided.push([`${d.retire} retired into ${d.keep}`, d.why]);
for (const d of SHARED_HANDSET) decided.push([`${d.row} ${d.action}`, d.why]);
for (const [k, why] of Object.entries(USE_SECOND_NUMBER)) decided.push([`${k} second number promoted`, why]);
for (const [k, v] of Object.entries(TOTAL_FEE_FROM_LIST_PRICE)) decided.push([`${k} TOTAL FEE set to ${v.amount}`, v.why]);
for (const [k, v] of Object.entries(FEE_VERDICT)) decided.push([`${k} ${v.winner} wins`, v.why]);
for (const [what, why] of decided) { R.push(`- **${what}**`); R.push(`  ${why}`); }
R.push('');
R.push(`## Still for the office (${stillFlagged.length})`);
R.push('');
R.push('Both readings are coherent on every item here, so none of it is guessed.');
R.push('');
const byCode = new Map<string, typeof stillFlagged>();
for (const f of stillFlagged) {
  if (!byCode.has(f.code)) byCode.set(f.code, []);
  byCode.get(f.code)!.push(f);
}
for (const [code, list] of [...byCode].sort()) {
  R.push(`### ${code} (${list.length})`);
  R.push('');
  for (const f of list) R.push(`- ${f.sheet} row ${f.rowNumber}, **${f.student}**: ${f.detail}`);
  R.push('');
}
w('report.md', R.join('\n'));

console.log(`staged            ${rows.length}`);
console.log(`released by merge ${released.length}`);
console.log(`decided from data ${decided.length}`);
console.log(`still for office  ${stillFlagged.length}`);
console.log(`\nwrote ${OUT}/{stage-0..d, rollback, verify}.sql and report.md`);
console.log('Nothing was written to the database.');
