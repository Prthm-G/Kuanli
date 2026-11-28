import { describe, expect, it } from 'vitest';

import { metaDailyBody } from './test-fixtures';
import { MAX_META_DAILY_BYTES, MAX_META_ROWS, sumWithin, validateMetaDaily } from './meta-daily';

const run = (b: unknown) => validateMetaDaily(JSON.stringify(b));
const row = (patch: Record<string, unknown>) => {
  const b = metaDailyBody();
  return { ...b, rows: [{ ...b.rows[0], ...patch }, b.rows[1]] };
};

describe('validateMetaDaily', () => {
  it('accepts a well-formed day and keeps only known fields', () => {
    const r = run({ ...metaDailyBody(), extra: 1, rows: metaDailyBody().rows.map((x) => ({ ...x, name: 'x' })) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.rows).toHaveLength(2);
      expect(Object.keys(r.value.rows[0])).not.toContain('name');
      expect(r.value.rows[1].msg_started).toBeNull();
      expect(r.value.accountTz).toBe('America/Los_Angeles');
    }
  });

  it('rejects a bad envelope', () => {
    expect(run(metaDailyBody({ ad_account_id: 'act_1' })).ok).toBe(false);
    expect(run(metaDailyBody({ day: '2026-02-31' })).ok).toBe(false);
    expect(run(metaDailyBody({ account_tz: 'IST; drop' })).ok).toBe(false);
    expect(run(metaDailyBody({ rows: {} })).ok).toBe(false);
    expect(validateMetaDaily('nope').ok).toBe(false);
  });

  it('rejects a day in the future or older than 400 days', () => {
    const tomorrow2 = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    expect(run(metaDailyBody({ day: tomorrow2 })).ok).toBe(false);
    expect(run(metaDailyBody({ day: '2024-01-01' })).ok).toBe(false);
  });

  it('rejects malformed rows', () => {
    expect(run(row({ ad_id: '12ab' })).ok).toBe(false);
    expect(run(row({ region: '' })).ok).toBe(false);
    expect(run(row({ spend: -1 })).ok).toBe(false);
    expect(run(row({ spend: '10' })).ok).toBe(false);
    expect(run(row({ spend: 1.234 })).ok).toBe(false);
    expect(run(row({ impressions: 1.5 })).ok).toBe(false);
    expect(run(row({ campaign_id: 'x' })).ok).toBe(false);
  });

  it('rejects a duplicate ad and region in one day', () => {
    const b = metaDailyBody();
    expect(run({ ...b, rows: [b.rows[0], { ...b.rows[1], region: 'Punjab region' }] })).toEqual({
      ok: false,
      error: 'rows[1] duplicates an earlier ad and region',
    });
  });

  it('rejects out-of-range or non-finite numbers', () => {
    expect(run(row({ spend: 1e308 })).ok).toBe(false);
    expect(run(row({ spend: 1e-9 })).ok).toBe(false);
    expect(run(row({ spend: -1 })).ok).toBe(false);
    expect(run(row({ spend: 'NaN' })).ok).toBe(false);
    expect(run(row({ impressions: 2147483648 })).ok).toBe(false);
    expect(run(row({ impressions: 2147483647 })).ok).toBe(true);
  });

  it('rejects a phone-shaped region', () => {
    expect(run(row({ region: 'Call 98765 43210' })).ok).toBe(false);
  });

  it('rejects phone- or email-shaped names', () => {
    expect(run(row({ ad_name: 'Call 98765 43210' })).ok).toBe(false);
    expect(run(row({ campaign_name: 'x@y.com list' })).ok).toBe(false);
  });

  it('rejects region rows that do not sum to the account total within 1%', () => {
    expect(run(metaDailyBody({ account_total: { spend: 170, impressions: 0, clicks: 0 } }))).toEqual({
      ok: false,
      error: 'region rows do not sum to the account total',
    });
  });

  it('refuses an empty rows array unless the account total spend is 0', () => {
    expect(run(metaDailyBody({ account_total: { spend: 0.5, impressions: 0, clicks: 0 }, rows: [] }))).toEqual({
      ok: false,
      error: 'rows are empty but the account total spend is above 0',
    });
    expect(run(metaDailyBody({ account_total: { spend: 0, impressions: 0, clicks: 0 }, rows: [] })).ok).toBe(true);
  });

  it('caps size and row count', () => {
    expect(validateMetaDaily('x'.repeat(MAX_META_DAILY_BYTES + 1))).toEqual({ ok: false, error: 'body too large' });
    const b = metaDailyBody();
    const many = Array.from({ length: MAX_META_ROWS + 1 }, (_, i) => ({ ...b.rows[0], region: `R${i}`, spend: 0 }));
    expect(run({ ...b, account_total: { spend: 0, impressions: 0, clicks: 0 }, rows: many }).ok).toBe(false);
  });
});

describe('sumWithin', () => {
  it('allows 1%, with a 1 rupee floor', () => {
    expect(sumWithin(1000, 990)).toBe(true);
    expect(sumWithin(1000, 989)).toBe(false);
    expect(sumWithin(5, 5.9)).toBe(true);
    expect(sumWithin(5, 6.1)).toBe(false);
    expect(sumWithin(0, 0)).toBe(true);
  });
});
