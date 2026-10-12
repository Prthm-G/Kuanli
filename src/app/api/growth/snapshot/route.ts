// ============================================================
// POST /api/growth/snapshot  (KB-GROWTH-R1)
//
// Stores one weekly ads-scorecard snapshot for the owner-only /growth page.
// Called by the scorecard (`weekly.py --publish`) on this host after each
// Monday run, never by a browser.
//
// Auth is the same shared-secret pattern as /api/reports/eod: `x-cron-secret`
// must match GROWTH_SNAPSHOT_SECRET. There is no user session, so the write
// goes through the service-role client; RLS (migration 078) lets only the
// account owner read the rows back.
// ============================================================

import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/automations/admin-client';
import { validateSnapshot } from '@/lib/growth/validate';

export async function POST(request: Request) {
  const expected = process.env.GROWTH_SNAPSHOT_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: 'Growth snapshots not configured' },
      { status: 503 }
    );
  }
  // Constant-time compare, as in /api/flows/cron (length pre-check is
  // required by timingSafeEqual and leaks only the length).
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '');
  const want = Buffer.from(expected);
  if (supplied.length !== want.length || !timingSafeEqual(supplied, want)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = validateSnapshot(await request.text());
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  const { accountId, snapshotDate, payload } = result.value;
  const { error } = await supabaseAdmin()
    .from('growth_snapshots')
    .upsert(
      { account_id: accountId, snapshot_date: snapshotDate, payload },
      { onConflict: 'account_id,snapshot_date' }
    );
  if (error) {
    console.error('growth snapshot upsert failed:', error.message);
    return NextResponse.json(
      { error: 'Could not store snapshot' },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    account_id: accountId,
    snapshot_date: snapshotDate,
  });
}
