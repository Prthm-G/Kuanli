import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { readWorkbook } from '@/lib/admissions/xlsx-lite';
import { parseAdmissionSheet, looksLikeAdmissionSheet } from '@/lib/admissions/parse-sheet';
import { reconcile, type ReconciledRow } from '@/lib/admissions/reconcile';
import { exitCard, importMovesDeal, listExitCards, newestDealByContact, type ExitCard } from '@/lib/admissions/stage-move';
import { holdBackForIntake, implausibleIntake } from '@/lib/admissions/intake';
import { parseSheetName } from '@/lib/admissions/normalize';
import { isExitStage } from '@/lib/pipelines/closed';
import { encrypt } from '@/lib/whatsapp/encryption';

/**
 * Admission spreadsheet import (Excel-retirement, step 3).
 *
 * Same parser and reconciler as the one-time 2026-08 backfill
 * (`scripts/backfill-admissions.ts`), so the UI and the script can never
 * disagree about a borderline student.
 *
 * POST with `?dryRun=1` previews: nothing is written and the caller gets the
 * counts, the held-back rows and every flag. Without it the importable rows
 * are written. Both paths run identical parsing — the preview is the honest
 * rehearsal of the write, not a separate code path.
 *
 * Node runtime: the reader uses node:zlib.
 */
export const runtime = 'nodejs';
/** An admission workbook is a few hundred KB; refuse anything wild. */
const MAX_BYTES = 8 * 1024 * 1024;

interface ImportSummary {
  sheet: string;
  stats: ReturnType<typeof reconcile>['stats'];
  heldBack: Array<{ student: string; row: number; reason: string }>;
  flags: ReturnType<typeof reconcile>['flags'];
  unmappedHeaders: string[];
  /** Read errors, a held-back sheet, and the students to move by hand. */
  warnings: string[];
  /**
   * Students whose card is Lost or Not Interested. The import never moves those
   * cards: moving one to Enrolled reports a Purchase to Meta, so a person does it.
   */
  exitCards: ExitCard[];
  written?: { contacts: number; plans: number; payments: number; discounts: number; credentials: number; deals: number; cardReadErrors: number };
}

type Db = ReturnType<typeof supabaseAdmin>;

/** The board the import writes deals to, and its stages. `failed` when either read errored. */
async function loadBoard(db: Db, accountId: string) {
  const { data: pipeline, error } = await db
    .from('pipelines')
    .select('id')
    .eq('account_id', accountId)
    .eq('name', 'LPU Admissions')
    .maybeSingle();
  const { data: stages, error: stagesError } = pipeline
    ? await db.from('pipeline_stages').select('id, name, position').eq('pipeline_id', pipeline.id)
    : { data: null, error: null };
  return { pipeline, stages: stages ?? [], failed: !!error || !!stagesError };
}

const BOARD_UNREAD = 'Could not read the LPU Admissions board: no card was checked, created or moved.';
const exitCardsWarning = (n: number) =>
  `${n} student(s) in this sheet have a Lost or Not Interested card: move them to Enrolled by hand (or to Application ` +
  'Started, as listed). The import does not move those cards.';

/**
 * Dry-run: the students whose newest LPU Admissions card is Lost or Not
 * Interested. Same contact lookup, board and card choice as the write.
 */
async function previewExitCards(db: Db, accountId: string, rows: ReconciledRow[]): Promise<{ cards: ExitCard[]; warnings: string[] }> {
  const { pipeline, stages, failed } = await loadBoard(db, accountId);
  if (failed) return { cards: [], warnings: [BOARD_UNREAD] };
  const stageName = new Map(stages.map((s) => [s.id as string, s.name as string]));
  const phones = [...new Set(rows.filter((r) => r.importPhone).map((r) => r.importPhone))];
  if (!pipeline || !phones.length) return { cards: [], warnings: [] };
  const contactByPhone = new Map<string, { id: string; ldNumber: string | null }>();
  const stageByContact = new Map<string, string>();
  let unread = 0;
  for (let i = 0; i < phones.length; i += 200) {
    const batch = phones.slice(i, i + 200);
    const { data: contacts, error } = await db
      .from('contacts')
      .select('id, phone_normalized, roll_number')
      .eq('account_id', accountId)
      .in('phone_normalized', batch);
    if (error) {
      unread += batch.length;
      continue;
    }
    for (const c of contacts ?? []) {
      contactByPhone.set(c.phone_normalized as string, { id: c.id as string, ldNumber: (c.roll_number as string | null) ?? null });
    }
    const ids = (contacts ?? []).map((c) => c.id as string);
    if (!ids.length) continue;
    const { data: deals, error: dealsError } = await db
      .from('deals')
      .select('id, contact_id, stage_id, created_at')
      .eq('pipeline_id', pipeline.id)
      .in('contact_id', ids);
    if (dealsError) {
      unread += ids.length;
      continue;
    }
    for (const [contactId, d] of newestDealByContact(deals ?? [])) {
      const name = stageName.get(d.stage_id);
      if (name) stageByContact.set(contactId, name);
    }
  }
  const cards = listExitCards(rows, contactByPhone, stageByContact);
  const warnings = unread
    ? [`Could not read the cards of ${unread} student(s): the list of Lost or Not Interested cards may be incomplete.`]
    : [];
  return { cards, warnings };
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const url = new URL(request.url);
    const dryRun = url.searchParams.get('dryRun') === '1';
    const wantedSheet = url.searchParams.get('sheet');

    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: 'File is too large' }, { status: 413 });
    }

    let workbook;
    try {
      workbook = readWorkbook(Buffer.from(await file.arrayBuffer()));
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Could not read the spreadsheet' },
        { status: 400 },
      );
    }

    // Offer only the tabs that actually look like an admission register.
    const candidates = workbook.sheetNames.filter((n) => {
      try {
        return looksLikeAdmissionSheet(workbook.sheet(n));
      } catch {
        return false;
      }
    });
    if (!candidates.length) {
      return NextResponse.json(
        { error: 'No sheet in this workbook looks like an admission register' },
        { status: 400 },
      );
    }
    if (!wantedSheet) {
      return NextResponse.json({ sheets: candidates });
    }
    if (!candidates.includes(wantedSheet)) {
      return NextResponse.json({ error: `Sheet "${wantedSheet}" is not an admission register`, sheets: candidates }, { status: 400 });
    }

    const { rows, unmappedHeaders } = parseAdmissionSheet(wantedSheet, workbook.sheet(wantedSheet));
    const meta = parseSheetName(wantedSheet)!;
    // An implausible tab (a typo like "2062-1") imports nothing, so its intake never reaches the contacts.
    const implausible = implausibleIntake({ year: meta.intakeYear, session: meta.intakeSession });
    const result = implausible ? holdBackForIntake(reconcile(rows), implausible) : reconcile(rows);

    const summary: ImportSummary = {
      sheet: wantedSheet,
      stats: result.stats,
      heldBack: result.heldBack.map((h) => ({
        student: h.row.name,
        row: h.row.rowNumber,
        reason: h.reason,
      })),
      flags: result.flags,
      unmappedHeaders,
      warnings: implausible ? [`Sheet held back: ${implausible}.`] : [],
      exitCards: [],
    };

    const out: { cards: ExitCard[]; warnings: string[]; written?: ImportSummary['written'] } = dryRun
      ? await previewExitCards(supabaseAdmin(), ctx.accountId, result.importable)
      : await writeRows(ctx.accountId, ctx.userId, result.importable);
    summary.exitCards = out.cards;
    summary.warnings.push(...out.warnings);
    if (out.cards.length) summary.warnings.push(exitCardsWarning(out.cards.length));
    if (out.written) summary.written = out.written;
    return NextResponse.json(summary);
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Writes the importable rows. Every statement is idempotent on a re-import:
 * contacts key on the account's unique normalized phone, and each child row
 * checks for its own prior existence, so running the same sheet twice adds
 * nothing.
 */
async function writeRows(
  accountId: string,
  userId: string,
  rows: ReconciledRow[],
): Promise<{ written: NonNullable<ImportSummary['written']>; cards: ExitCard[]; warnings: string[] }> {
  const db = supabaseAdmin();
  const written = { contacts: 0, plans: 0, payments: 0, discounts: 0, credentials: 0, deals: 0, cardReadErrors: 0 };
  const cards: ExitCard[] = [];
  const listed = new Set<string>();

  const { pipeline, stages, failed: boardUnread } = await loadBoard(db, accountId);
  const stageByName = new Map((stages ?? []).map((s) => [s.name as string, s]));

  for (const row of rows) {
    // 1) Contact — never clobber a value the CRM already holds.
    let contactId: string | null = null;
    let ldNumber: string | null = null;
    if (row.importPhone) {
      const { data: existing } = await db
        .from('contacts')
        .select('id, name, email, university, intake_year, intake_session, university_roll_number, roll_number')
        .eq('account_id', accountId)
        .eq('phone_normalized', row.importPhone)
        .maybeSingle();

      if (existing) {
        contactId = existing.id;
        ldNumber = existing.roll_number ?? null;
        await db
          .from('contacts')
          .update({
            name: existing.name ?? row.name,
            email: existing.email ?? (row.email || null),
            university: existing.university ?? 'LPU',
            intake_year: existing.intake_year ?? row.intakeYear,
            intake_session: existing.intake_session ?? row.intakeSession,
            university_roll_number:
              existing.university_roll_number ?? (row.universityRollNumber || null),
          })
          .eq('id', contactId);
      }
    }

    if (!contactId) {
      const { data: inserted, error } = await db
        .from('contacts')
        .insert({
          account_id: accountId,
          user_id: userId,
          phone: row.importPhone,
          name: row.name,
          email: row.email || null,
          university: 'LPU',
          intake_year: row.intakeYear,
          intake_session: row.intakeSession,
          university_roll_number: row.universityRollNumber || null,
          source: 'organic',
          source_detail: 'excel-migration',
        })
        .select('id')
        .single();
      if (error || !inserted) continue;
      contactId = inserted.id;
      written.contacts++;
    }

    const note = `Imported from Excel "${row.sheet}" row ${row.rowNumber}.`;

    // 2) Fee plan — only when the sheet recorded a price.
    if (row.agreedTotal !== null) {
      const { error } = await db.from('student_fee_plans').insert({
        account_id: accountId,
        contact_id: contactId,
        university: 'LPU',
        mode: row.effectiveMode,
        program: row.course.program,
        specialization: row.course.specialization ?? '',
        currency: 'INR',
        agreed_total: row.agreedTotal,
        note,
        created_by: userId,
      });
      if (!error) written.plans++;
    }

    const { data: plan } = await db
      .from('student_fee_plans')
      .select('id')
      .eq('contact_id', contactId)
      .maybeSingle();

    // 3) One opening-balance payment.
    if (row.openingPaid > 0) {
      const { count } = await db
        .from('payments')
        .select('id', { count: 'exact', head: true })
        .eq('contact_id', contactId)
        .like('note', 'Opening balance migrated from Excel%');
      if (!count) {
        const { error } = await db.from('payments').insert({
          account_id: accountId,
          contact_id: contactId,
          plan_id: plan?.id ?? null,
          paid_at: row.paymentDate ? new Date(row.paymentDate).toISOString() : new Date().toISOString(),
          amount: row.openingPaid,
          currency: 'INR',
          method: 'other',
          note: `Opening balance migrated from Excel (${row.sheet} row ${row.rowNumber})`,
          status: 'verified',
          logged_by: userId,
          verified_by: userId,
          verified_at: new Date().toISOString(),
        });
        if (!error) written.payments++;
      }
    }

    // 4) Concession already granted by the office.
    if (row.discountAmount > 0) {
      const { count } = await db
        .from('fee_discounts')
        .select('id', { count: 'exact', head: true })
        .eq('contact_id', contactId)
        .like('reason', 'Concession recorded in the office spreadsheet%');
      if (!count) {
        const { error } = await db.from('fee_discounts').insert({
          account_id: accountId,
          contact_id: contactId,
          plan_id: plan?.id ?? null,
          amount: row.discountAmount,
          reason: `Concession recorded in the office spreadsheet (${row.sheet} row ${row.rowNumber})`,
          status: 'approved',
          proposed_by: userId,
          decided_by: userId,
          decided_at: new Date().toISOString(),
          decision_note: 'Approved historically; imported from Excel.',
        });
        if (!error) written.discounts++;
      }
    }

    // 5) Portal credential — encrypted at rest, like every other write path.
    if (row.portalPassword) {
      const { count } = await db
        .from('student_portal_credentials')
        .select('id', { count: 'exact', head: true })
        .eq('contact_id', contactId)
        .eq('label', 'LPU student portal');
      if (!count) {
        const { error } = await db.from('student_portal_credentials').insert({
          account_id: accountId,
          contact_id: contactId,
          label: 'LPU student portal',
          username: row.universityRollNumber || null,
          password_ciphertext: encrypt(row.portalPassword),
          notes: 'Imported from the office spreadsheet.',
          created_by: userId,
        });
        if (!error) written.credentials++;
      }
    }

    // 6) Deal — create, or advance an existing card (importMovesDeal).
    const target = stageByName.get(row.stage);
    if (pipeline && target && !boardUnread) {
      // The newest card on the board (the dry-run counts the same one). With
      // several, maybeSingle used to fail and a duplicate card was inserted.
      const { data: deals, error: dealsError } = await db
        .from('deals')
        .select('id, contact_id, stage_id, created_at')
        .eq('contact_id', contactId)
        .eq('pipeline_id', pipeline.id);
      // One contact here, so its newest card is the only value.
      const deal = dealsError ? undefined : [...newestDealByContact(deals ?? []).values()][0];

      if (dealsError) {
        // Unknown: neither insert a second card nor move one, and say so.
        written.cardReadErrors++;
      } else if (!deal) {
        const { error } = await db.from('deals').insert({
          user_id: userId,
          account_id: accountId,
          pipeline_id: pipeline.id,
          stage_id: target.id,
          contact_id: contactId,
          title: row.name,
          value: row.agreedTotal ?? 0,
          currency: 'INR',
          notes: note,
        });
        if (!error) written.deals++;
      } else {
        const current = (stages ?? []).find((s) => s.id === deal.stage_id);
        if (current && isExitStage(current.name)) {
          // Never moved by the import: listed for a person to move.
          if (!listed.has(deal.contact_id)) cards.push(exitCard(row, current.name, ldNumber));
          listed.add(deal.contact_id);
        } else if (current && importMovesDeal(current, target)) {
          await db.from('deals').update({ stage_id: target.id }).eq('id', deal.id);
          written.deals++;
        }
      }
    }
  }

  const warnings: string[] = [];
  if (boardUnread) warnings.push(BOARD_UNREAD);
  if (written.cardReadErrors) {
    warnings.push(`${written.cardReadErrors} student(s) skipped at the card step: their cards could not be read, so none was created or moved.`);
  }
  return { written, cards, warnings };
}
