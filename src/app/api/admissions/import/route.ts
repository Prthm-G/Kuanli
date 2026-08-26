import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { readWorkbook } from '@/lib/admissions/xlsx-lite';
import { parseAdmissionSheet, looksLikeAdmissionSheet } from '@/lib/admissions/parse-sheet';
import { reconcile, type ReconciledRow } from '@/lib/admissions/reconcile';
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
  written?: { contacts: number; plans: number; payments: number; discounts: number; credentials: number; deals: number };
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
    const result = reconcile(rows);

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
    };

    if (dryRun) return NextResponse.json(summary);

    summary.written = await writeRows(ctx.accountId, ctx.userId, result.importable);
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
): Promise<NonNullable<ImportSummary['written']>> {
  const db = supabaseAdmin();
  const written = { contacts: 0, plans: 0, payments: 0, discounts: 0, credentials: 0, deals: 0 };

  const { data: pipeline } = await db
    .from('pipelines')
    .select('id')
    .eq('account_id', accountId)
    .eq('name', 'LPU Admissions')
    .maybeSingle();

  const { data: stages } = pipeline
    ? await db.from('pipeline_stages').select('id, name, position').eq('pipeline_id', pipeline.id)
    : { data: null };
  const stageByName = new Map((stages ?? []).map((s) => [s.name as string, s]));

  for (const row of rows) {
    // 1) Contact — never clobber a value the CRM already holds.
    let contactId: string | null = null;
    if (row.importPhone) {
      const { data: existing } = await db
        .from('contacts')
        .select('id, name, email, university, intake_year, intake_session, university_roll_number')
        .eq('account_id', accountId)
        .eq('phone_normalized', row.importPhone)
        .maybeSingle();

      if (existing) {
        contactId = existing.id;
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

    // 6) Deal — create, or advance an existing card forward only.
    const target = stageByName.get(row.stage);
    if (pipeline && target) {
      const { data: deal } = await db
        .from('deals')
        .select('id, stage_id')
        .eq('contact_id', contactId)
        .eq('pipeline_id', pipeline.id)
        .maybeSingle();

      if (!deal) {
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
        // Forward-only, mirroring lifecycle_sweep: never drag a card backwards.
        if (current && current.position < target.position) {
          await db.from('deals').update({ stage_id: target.id }).eq('id', deal.id);
          written.deals++;
        }
      }
    }
  }

  return written;
}
