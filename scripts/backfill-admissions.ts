/**
 * Excel -> Kuanli admissions backfill (2026-08 migration).
 *
 * Reads the office workbook, runs it through the shared parser/reconciler in
 * `src/lib/admissions`, and emits:
 *   - a human-readable reconciliation report for the office,
 *   - staged SQL (A contacts, B fees, C deals) plus a rollback script.
 *
 * It writes NOTHING to the database itself: the SQL is reviewed, then applied
 * stage by stage with a verification pause between each. Every stage is
 * idempotent, so a re-run inserts nothing new.
 *
 *   node --experimental-strip-types --import ./scripts/ts-loader.mjs \
 *     scripts/backfill-admissions.ts --out <dir> [--workbook <path>]
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

// Required: the workbook holds student PII and lives outside the repo, so
// there is deliberately no default path baked into the source.
const WORKBOOK = arg('workbook');
const OUT = arg('out');
const ACCOUNT_ID = arg('account');
const OWNER_ID = arg('owner');
const PIPELINE = arg('pipeline', 'LPU Admissions');
const UNIVERSITY = arg('university', 'LPU');

/** SQL string literal; single quotes doubled. Never interpolate raw input. */
const q = (v: string | null | undefined): string =>
  v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
const num = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v) ? 'NULL' : String(v);

/** Stable identity for a sheet row, so re-running cannot double-insert. */
const sourceKey = (r: ReconciledRow) => `${r.sheet}#${r.rowNumber}`;

function buildNote(r: ReconciledRow): string {
  const bits = [`Migrated from Excel "${r.sheet}" row ${r.rowNumber} on ${new Date().toISOString().slice(0, 10)}.`];
  if (r.fatherName) bits.push(`Father: ${r.fatherName}.`);
  if (r.rawCourse) bits.push(`Course as written: "${r.rawCourse}".`);
  if (r.receiptNumber) bits.push(`Receipts: ${r.receiptNumber}.`);
  if (r.rawPaymentDate && !r.paymentDate) bits.push(`Payment dates as written: "${r.rawPaymentDate}".`);
  if (r.phoneIssue === 'not-indian-mobile') bits.push(`Phone in sheet was "${r.phoneRaw}" (not a valid mobile).`);
  if (!r.feeReconciles) bits.push('Fee columns did not reconcile at migration; verify with the office.');
  return bits.join(' ');
}

// ---------------------------------------------------------------- parse
const wb = readWorkbook(readFileSync(WORKBOOK));
const parsed = ACTIVE_SHEETS.flatMap((name) => parseAdmissionSheet(name, wb.sheet(name)).rows);
const res = reconcile(parsed);

mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- report
const lines: string[] = [];
const push = (s = '') => lines.push(s);

push('# Admission migration - reconciliation report');
push();
push(`Workbook: \`${path.basename(WORKBOOK)}\``);
push(`Sheets: ${ACTIVE_SHEETS.join(', ')}`);
push();
push('## Totals');
push();
push('| Measure | Count |');
push('|---|---|');
for (const [k, v] of Object.entries(res.stats)) push(`| ${k} | ${v} |`);
push();
push('## Held back - a human must decide (not imported)');
push();
push('These rows share a phone number. Kuanli allows one contact per number, and');
push('the sheet cannot tell us whether these are one student re-enrolling or two');
push('people sharing a handset.');
push();
for (const h of res.heldBack) {
  push(`- **${h.row.name}** - ${h.row.sheet} row ${h.row.rowNumber} - ${h.reason}`);
}
push();
push('## Flags on imported rows');
push();
const byCode = new Map<string, typeof res.flags>();
for (const f of res.flags) {
  if (f.code === 'duplicate-phone') continue;
  const list = byCode.get(f.code) ?? [];
  list.push(f);
  byCode.set(f.code, list);
}
for (const [code, list] of [...byCode.entries()].sort((a, b) => b[1].length - a[1].length)) {
  push(`### ${code} (${list.length})`);
  push();
  for (const f of list) push(`- ${f.sheet} row ${f.rowNumber} - **${f.student}** - ${f.detail}`);
  push();
}
writeFileSync(path.join(OUT, 'reconciliation-report.md'), lines.join('\n'));

// ---------------------------------------------------------------- SQL
const sql: string[] = [];
sql.push('-- Stage A: staging table + contacts. Idempotent, one transaction.');
sql.push('BEGIN;');
sql.push(`
CREATE TABLE IF NOT EXISTS admission_import_staging (
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
);`);
sql.push('TRUNCATE admission_import_staging;');
sql.push('');

const values = res.importable.map((r) => {
  const cipher = r.portalPassword ? encrypt(r.portalPassword) : null;
  return `(${[
    q(sourceKey(r)), q(ACCOUNT_ID), q(r.sheet), String(r.rowNumber), q(r.name),
    q(r.importPhone), q(r.email || null), q(UNIVERSITY), q(r.effectiveMode),
    q(r.course.program), q(r.course.specialization ?? ''), q(r.intakeYear), q(r.intakeSession),
    q(r.universityRollNumber || null), num(r.agreedTotal), num(r.discountAmount),
    num(r.openingPaid), q(r.stage), q(cipher), q(r.paymentDate), q(buildNote(r)),
  ].join(', ')})`;
});

sql.push('INSERT INTO admission_import_staging (');
sql.push('  source_key, account_id, sheet, row_number, name, phone, email, university, mode,');
sql.push('  program, specialization, intake_year, intake_session, university_roll_number,');
sql.push('  agreed_total, discount, paid, stage_name, password_ciphertext, paid_at, note');
sql.push(') VALUES');
sql.push(values.join(',\n') + ';');
sql.push('');

sql.push(`-- Existing contacts win on every field they already have (fill-blanks-only).
INSERT INTO contacts (account_id, user_id, phone, name, email, university,
                      intake_year, intake_session, university_roll_number, source, source_detail)
SELECT s.account_id, ${q(OWNER_ID)}::uuid, s.phone, s.name, NULLIF(s.email,''), s.university,
       s.intake_year, s.intake_session, s.university_roll_number, 'organic', 'excel-migration'
FROM admission_import_staging s
WHERE s.phone <> ''
ON CONFLICT (account_id, phone_normalized) WHERE phone_normalized <> ''
DO UPDATE SET
  name                   = COALESCE(contacts.name, EXCLUDED.name),
  email                  = COALESCE(contacts.email, EXCLUDED.email),
  university             = COALESCE(contacts.university, EXCLUDED.university),
  intake_year            = COALESCE(contacts.intake_year, EXCLUDED.intake_year),
  intake_session         = COALESCE(contacts.intake_session, EXCLUDED.intake_session),
  university_roll_number = COALESCE(contacts.university_roll_number, EXCLUDED.university_roll_number),
  updated_at             = now();`);
sql.push('');

sql.push(`-- Phone-less students: the unique index excludes empty numbers, so they are
-- matched on name + intake instead to keep the re-run idempotent.
INSERT INTO contacts (account_id, user_id, phone, name, email, university,
                      intake_year, intake_session, university_roll_number, source, source_detail)
SELECT s.account_id, ${q(OWNER_ID)}::uuid, '', s.name, NULLIF(s.email,''), s.university,
       s.intake_year, s.intake_session, s.university_roll_number, 'organic', 'excel-migration'
FROM admission_import_staging s
WHERE s.phone = ''
  AND NOT EXISTS (
    SELECT 1 FROM contacts c
    WHERE c.account_id = s.account_id AND c.phone = ''
      AND lower(c.name) = lower(s.name)
      AND c.intake_year IS NOT DISTINCT FROM s.intake_year
      AND c.intake_session IS NOT DISTINCT FROM s.intake_session
  );`);
sql.push('');

sql.push(`-- Point every staged row at its contact.
UPDATE admission_import_staging s SET contact_id = c.id
FROM contacts c
WHERE c.account_id = s.account_id
  AND s.phone <> '' AND c.phone_normalized = regexp_replace(s.phone, '\\D', '', 'g');

UPDATE admission_import_staging s SET contact_id = c.id
FROM contacts c
WHERE c.account_id = s.account_id AND s.phone = '' AND c.phone = ''
  AND lower(c.name) = lower(s.name)
  AND c.intake_year IS NOT DISTINCT FROM s.intake_year
  AND c.intake_session IS NOT DISTINCT FROM s.intake_session
  AND s.contact_id IS NULL;`);
sql.push('');
sql.push(`-- Refuse to continue if any row failed to resolve.
DO $$
DECLARE n INTEGER;
BEGIN
  SELECT count(*) INTO n FROM admission_import_staging WHERE contact_id IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'Stage A: % staged rows have no contact_id', n; END IF;
END $$;`);
sql.push('COMMIT;');
writeFileSync(path.join(OUT, 'stage-a-contacts.sql'), sql.join('\n'));

// ---- Stage B: fees
const b: string[] = [];
b.push('-- Stage B: fee plans, opening-balance payments, discounts, portal credentials.');
b.push('BEGIN;');
b.push(`INSERT INTO student_fee_plans (account_id, contact_id, university, mode, program,
                               specialization, currency, agreed_total, note, created_by)
SELECT s.account_id, s.contact_id, s.university, s.mode, s.program, s.specialization,
       'INR', s.agreed_total, s.note, ${q(OWNER_ID)}::uuid
FROM admission_import_staging s
WHERE s.agreed_total IS NOT NULL
ON CONFLICT (contact_id) DO NOTHING;`);
b.push('');
b.push(`-- One opening balance per student. amount > 0 is enforced by the table.
INSERT INTO payments (account_id, contact_id, plan_id, paid_at, amount, currency, method,
                      reference, note, status, logged_by, verified_by, verified_at)
SELECT s.account_id, s.contact_id, p.id,
       COALESCE(s.paid_at::timestamptz, now()), s.paid, 'INR', 'other',
       NULL, 'Opening balance migrated from Excel (' || s.sheet || ' row ' || s.row_number || ')',
       'verified', ${q(OWNER_ID)}::uuid, ${q(OWNER_ID)}::uuid, now()
FROM admission_import_staging s
LEFT JOIN student_fee_plans p ON p.contact_id = s.contact_id
WHERE s.paid > 0
  AND NOT EXISTS (
    SELECT 1 FROM payments x WHERE x.contact_id = s.contact_id AND x.method = 'other'
      AND x.note LIKE 'Opening balance migrated from Excel%'
  );`);
b.push('');
b.push(`INSERT INTO fee_discounts (account_id, contact_id, plan_id, amount, reason, status,
                            proposed_by, decided_by, decided_at, decision_note)
SELECT s.account_id, s.contact_id, p.id, s.discount,
       'Concession recorded in the office spreadsheet (' || s.sheet || ' row ' || s.row_number || ')',
       'approved', ${q(OWNER_ID)}::uuid, ${q(OWNER_ID)}::uuid, now(),
       'Approved historically; migrated from Excel.'
FROM admission_import_staging s
LEFT JOIN student_fee_plans p ON p.contact_id = s.contact_id
WHERE s.discount > 0
  AND NOT EXISTS (
    SELECT 1 FROM fee_discounts d WHERE d.contact_id = s.contact_id
      AND d.reason LIKE 'Concession recorded in the office spreadsheet%'
  );`);
b.push('');
b.push(`INSERT INTO student_portal_credentials (account_id, contact_id, label, portal_url,
                                        username, password_ciphertext, notes, created_by)
SELECT s.account_id, s.contact_id, 'LPU student portal', NULL,
       NULLIF(s.university_roll_number,''), s.password_ciphertext,
       'Migrated from the office spreadsheet.', ${q(OWNER_ID)}::uuid
FROM admission_import_staging s
WHERE s.password_ciphertext IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM student_portal_credentials c
    WHERE c.contact_id = s.contact_id AND c.label = 'LPU student portal'
  );`);
b.push('COMMIT;');
writeFileSync(path.join(OUT, 'stage-b-fees.sql'), b.join('\n'));

// ---- Stage C: deals
const c: string[] = [];
c.push('-- Stage C: one deal per student in the university pipeline.');
c.push('BEGIN;');
c.push(`INSERT INTO deals (user_id, account_id, pipeline_id, stage_id, contact_id, title,
                   value, currency, notes)
SELECT ${q(OWNER_ID)}::uuid, s.account_id, pl.id, st.id, s.contact_id,
       s.name, COALESCE(s.agreed_total, 0), 'INR', s.note
FROM admission_import_staging s
JOIN pipelines pl ON pl.account_id = s.account_id AND pl.name = ${q(PIPELINE)}
JOIN pipeline_stages st ON st.pipeline_id = pl.id AND st.name = s.stage_name
WHERE NOT EXISTS (
  SELECT 1 FROM deals d WHERE d.contact_id = s.contact_id AND d.pipeline_id = pl.id
);`);
c.push('');
c.push(`-- A student already in the CRM as a WhatsApp lead keeps their existing deal;
-- the migration only advances it to the stage the spreadsheet proves they reached.
-- Forward-only, matching lifecycle_sweep: a card is never dragged backwards.
UPDATE deals d
SET stage_id = st.id, updated_at = now()
FROM admission_import_staging s
JOIN pipelines pl ON pl.account_id = s.account_id AND pl.name = ${q(PIPELINE)}
JOIN pipeline_stages st ON st.pipeline_id = pl.id AND st.name = s.stage_name,
     pipeline_stages cur
WHERE d.contact_id = s.contact_id
  AND d.pipeline_id = pl.id
  AND cur.id = d.stage_id
  AND cur.position < st.position;`);
c.push('COMMIT;');
writeFileSync(path.join(OUT, 'stage-c-deals.sql'), c.join('\n'));

// ---- rollback
const rb = `-- Rollback for the Excel admissions migration.
-- Removes ONLY rows this migration created, identified via the staging table.
BEGIN;
DELETE FROM deals d USING admission_import_staging s
  WHERE d.contact_id = s.contact_id AND d.notes = s.note;
DELETE FROM student_portal_credentials c USING admission_import_staging s
  WHERE c.contact_id = s.contact_id AND c.label = 'LPU student portal';
DELETE FROM fee_discounts x USING admission_import_staging s
  WHERE x.contact_id = s.contact_id AND x.reason LIKE 'Concession recorded in the office spreadsheet%';
DELETE FROM payments p USING admission_import_staging s
  WHERE p.contact_id = s.contact_id AND p.note LIKE 'Opening balance migrated from Excel%';
DELETE FROM student_fee_plans p USING admission_import_staging s
  WHERE p.contact_id = s.contact_id AND p.note = s.note;
-- Contacts created by the migration only (never ones that pre-existed).
DELETE FROM contacts c USING admission_import_staging s
  WHERE c.id = s.contact_id AND c.source_detail = 'excel-migration';
DROP TABLE IF EXISTS admission_import_staging;
COMMIT;
`;
writeFileSync(path.join(OUT, 'rollback.sql'), rb);

console.log(`parsed=${res.stats.parsed} importable=${res.stats.importable} heldBack=${res.stats.heldBack}`);
console.log(`enrolled=${res.stats.enrolled} applicationStarted=${res.stats.applicationStarted}`);
console.log(`payments=${res.stats.withPayment} discounts=${res.stats.withDiscount} credentials=${res.stats.withPassword}`);
console.log(`flags=${res.flags.length} (feeMismatch=${res.stats.feeMismatches}, noPhone=${res.stats.noPhone}, badPhone=${res.stats.badPhone}, course=${res.stats.unresolvedCourse})`);
console.log(`written to ${OUT}`);
