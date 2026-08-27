/**
 * POST /api/bot/report-conversions (KB-COURSEINFO-R5-53)
 *
 * Deliver queued Meta conversions. The trigger on `deals` (migration 068) only
 * NOTICES a conversion and writes a 'pending' row; something has to actually
 * send them, and that something must run where the code and the encryption key
 * live. The host cron cannot import the app's TypeScript (the production
 * container ships compiled output), so the sweep calls this route instead -
 * the same host-to-app boundary /api/bot/course-info already established, with
 * the same auth.
 *
 * Everything that decides WHETHER a row is sent lives in
 * src/lib/meta/conversions.ts. This route only chooses WHICH rows are due:
 *   - status pending or failed (skips are permanent verdicts),
 *   - event_time inside Meta's 7-day window - one stale event fails the whole
 *     request it rides in, so stale rows are marked 'skipped'/'event_too_old'
 *     here rather than allowed to poison a batch.
 *
 * Serialised on purpose: rows are reported one at a time. The volume is tens
 * per day, and the dedup guarantee (deterministic event_id, UNIQUE in 065)
 * makes retries safe but not free - parallel sends of the same row from two
 * overlapping crons would both hit Meta before either audit lands. The cron
 * runs every 15 minutes; a serial pass of even hundreds of rows finishes in
 * seconds.
 */

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  cameFromPublicInternet,
  verifySharedSecret,
  verifySignature,
} from '@/lib/bot/auth';
import {
  isWithinEventWindow,
  reportConversion,
  type ConversionEventName,
} from '@/lib/meta/conversions';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _admin: any = null;
function supabaseAdmin() {
  if (!_admin) {
    _admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _admin;
}

interface DueRow {
  account_id: string;
  conversation_id: string;
  event_name: string;
  event_time: string;
  value: number | null;
  currency: string | null;
}

export async function POST(request: Request) {
  if (cameFromPublicInternet(request)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const rawBody = await request.text();
  const authorised =
    verifySignature(
      rawBody,
      request.headers.get('X-Webhook-Timestamp') ?? '',
      request.headers.get('X-Webhook-Signature') ?? ''
    ) || verifySharedSecret(request.headers.get('X-Webhook-Secret') ?? '');
  if (!authorised) {
    return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  }

  const db = supabaseAdmin();

  // Expire what can never be delivered, so the queue does not grow a tail of
  // rows that would fail every batch they join.
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: expired } = await db
    .from('meta_conversion_events')
    .update({
      status: 'skipped',
      reason: 'event_too_old',
      updated_at: new Date().toISOString(),
    })
    .in('status', ['pending', 'failed'])
    .lte('event_time', cutoff)
    .select('id');

  const { data: due, error: dueError } = await db
    .from('meta_conversion_events')
    .select(
      'account_id, conversation_id, event_name, event_time, value, currency'
    )
    .in('status', ['pending', 'failed'])
    .gt('event_time', cutoff)
    .order('event_time', { ascending: true })
    .limit(200);

  if (dueError) {
    return NextResponse.json(
      { error: `queue read failed: ${dueError.message}` },
      { status: 500 }
    );
  }

  const tally: Record<string, number> = {};
  for (const r of (due ?? []) as DueRow[]) {
    const eventTime = new Date(r.event_time);
    // Belt to the SQL braces above; the same guard the module itself applies.
    if (!isWithinEventWindow(eventTime)) continue;

    const res = await reportConversion(db, {
      accountId: r.account_id,
      conversationId: r.conversation_id,
      eventName: r.event_name as ConversionEventName,
      value: r.value ?? undefined,
      currency: r.currency ?? undefined,
      eventTime,
    });
    const key = res.reported
      ? 'sent'
      : 'skipped' in res
        ? `skipped:${res.skipped}`
        : `failed:${res.error}`;
    tally[key] = (tally[key] ?? 0) + 1;
  }

  return NextResponse.json({
    due: due?.length ?? 0,
    expired: expired?.length ?? 0,
    tally,
  });
}
