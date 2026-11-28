// ============================================================
// POST /api/growth/meta-daily  (KB-JOURNEY-R2)
//
// Stores one Meta ad account day of ad x region spend for the owner-only /growth page. Called by the morning fetch on
// this host (devtools/morning-v2/validate.mjs) after it has checked timezone, days, schema and the region-vs-total sum,
// never by a browser. Same shared-secret auth as /api/growth/snapshot (GROWTH_SNAPSHOT_SECRET, x-cron-secret,
// constant-time compare). The Kuanli account is the one whose ad_catalog carries this Meta ad account; the day is
// replaced atomically by meta_ad_daily_replace (migration 105), so a re-post or a Meta revision leaves no stale row.
// ============================================================

import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/automations/admin-client';
import { MAX_META_DAILY_BYTES, validateMetaDaily } from '@/lib/growth/meta-daily';

export async function POST(request: Request) {
  const expected = process.env.GROWTH_SNAPSHOT_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'Growth snapshots not configured' }, { status: 503 });
  }
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '');
  const want = Buffer.from(expected);
  if (supplied.length !== want.length || !timingSafeEqual(supplied, want)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_META_DAILY_BYTES) {
    return NextResponse.json({ error: 'body too large' }, { status: 413 });
  }
  const result = validateMetaDaily(await request.text());
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  const { adAccountId, day, accountTz, rows } = result.value;

  const db = supabaseAdmin();
  const { data: owners, error: lookupError } = await db
    .from('ad_catalog')
    .select('account_id')
    .eq('ad_account_id', adAccountId);
  if (lookupError) {
    console.error('meta-daily account lookup failed:', lookupError.message);
    return NextResponse.json({ error: 'Could not store spend' }, { status: 500 });
  }
  const accounts = [...new Set((owners ?? []).map((o) => o.account_id as string))];
  if (accounts.length !== 1) {
    return NextResponse.json({ error: 'unknown ad account' }, { status: 422 });
  }

  const { data: stored, error } = await db.rpc('meta_ad_daily_replace', {
    p_account: accounts[0],
    p_ad_account: adAccountId,
    p_day: day,
    p_tz: accountTz,
    p_rows: rows,
  });
  if (error) {
    console.error('meta-daily replace failed:', error.message);
    return NextResponse.json({ error: 'Could not store spend' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, ad_account_id: adAccountId, day, stored: Number(stored ?? 0) });
}
