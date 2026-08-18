// ============================================================
// POST /api/followups/dispatch
//
// Sends due follow-up messages. Scheduled externally — the n8n
// workflow "Kuanli Follow-up Dispatch" calls this every 30
// minutes — so the schedule lives with the rest of the
// automation and this route stays a plain, testable trigger.
//
// Auth deliberately reuses EOD_REPORT_SECRET: both routes have
// the same single caller identity (the n8n cron credential
// "Kuanli EOD Cron Secret"), and reusing it means no new secret
// material to plumb through compose + n8n. If the cron caller
// ever splits identities, split the env var then.
//
// Eligibility lives in follow_ups_due() (migration 044): ladder
// rung selection, once-per-spell ledger check, 24h spacing,
// human-takeover and stage guards. This route only renders merge
// fields, sends via the same engine path automations use (so the
// message lands in the inbox thread as sender_type='bot' with a
// real Meta id), and writes the ledger row that prevents resend.
//
// Failure ordering: send first, then log. If the ledger insert
// fails after a successful send, the worst case is one duplicate
// follow-up 24h later (the spacing guard blocks anything sooner),
// and the response flags it loudly.
// ============================================================

import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/automations/admin-client';
import {
  engineSendText,
  engineSendTemplate,
} from '@/lib/automations/meta-send';
import { renderFollowUpBody } from '@/lib/followups/merge';

const PER_RUN_CAP = 25;

interface DueRow {
  contact_id: string;
  conversation_id: string;
  rung_id: string;
  rung_order: number;
  body: string | null;
  template_name: string | null;
  contact_name: string | null;
  interest_university: string | null;
  hours_silent: number;
}

export async function POST(request: Request) {
  const expected = process.env.EOD_REPORT_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  if (request.headers.get('x-cron-secret') !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = supabaseAdmin();

  const { data: accounts, error: accErr } = await db
    .from('accounts')
    .select('id');
  if (accErr) {
    return NextResponse.json({ error: accErr.message }, { status: 500 });
  }

  let sent = 0;
  const skipped: Array<{ contact_id: string; reason: string }> = [];
  const ledgerFailures: string[] = [];

  for (const account of accounts ?? []) {
    // Sender identity for the audit column on messages — the account owner,
    // same convention as the EOD report's recipient lookup.
    const { data: owner } = await db
      .from('profiles')
      .select('user_id')
      .eq('account_id', account.id)
      .eq('account_role', 'owner')
      .limit(1)
      .maybeSingle();
    if (!owner?.user_id) continue;

    const { data: due, error: dueErr } = await db.rpc('follow_ups_due', {
      p_account_id: account.id,
      p_limit: PER_RUN_CAP,
    });
    if (dueErr) {
      skipped.push({
        contact_id: account.id,
        reason: `due query: ${dueErr.message}`,
      });
      continue;
    }

    for (const row of (due ?? []) as DueRow[]) {
      try {
        const common = {
          accountId: account.id,
          userId: owner.user_id,
          conversationId: row.conversation_id,
          contactId: row.contact_id,
        };
        const { whatsapp_message_id } = row.template_name
          ? await engineSendTemplate({
              ...common,
              templateName: row.template_name,
            })
          : await engineSendText({
              ...common,
              text: renderFollowUpBody(row.body ?? '', {
                name: row.contact_name,
                university: row.interest_university,
              }),
            });

        sent += 1;

        const { error: logErr } = await db.from('follow_up_log').insert({
          account_id: account.id,
          contact_id: row.contact_id,
          rung_id: row.rung_id,
          conversation_id: row.conversation_id,
          message_id: whatsapp_message_id,
        });
        if (logErr) ledgerFailures.push(`${row.contact_id}: ${logErr.message}`);
      } catch (e) {
        skipped.push({
          contact_id: row.contact_id,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return NextResponse.json({ sent, skipped, ledger_failures: ledgerFailures });
}
