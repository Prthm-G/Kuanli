import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { loadCloseEvents } from './queries';

/**
 * A stand-in for the PostgREST builder: records each request's filters and
 * serves `rows` the way a server with `max_rows = cap` would (a page never
 * longer than the cap, whatever range was asked for).
 */
function fakeSupabase(rows: { id: string }[], cap: number, error?: string) {
  const requests: Record<string, unknown>[] = [];
  const client = {
    from(table: string) {
      const req: Record<string, unknown> = { table };
      requests.push(req);
      const b = {
        select(cols: string, opts: unknown) {
          req.select = cols;
          req.selectOpts = opts;
          return b;
        },
        eq(col: string, v: unknown) {
          req[`eq:${col}`] = v;
          return b;
        },
        in(col: string, v: unknown) {
          req[`in:${col}`] = v;
          return b;
        },
        gte(col: string, v: unknown) {
          req[`gte:${col}`] = v;
          return b;
        },
        order(col: string, opts: unknown) {
          req.order = [...((req.order as unknown[]) ?? []), [col, opts]];
          return b;
        },
        range(from: number, to: number) {
          req.range = [from, to];
          return b;
        },
        then(resolve: (r: unknown) => unknown) {
          if (error) return resolve({ data: null, count: null, error: { message: error } });
          const [from, to] = req.range as [number, number];
          const page = rows.slice(from, Math.min(to + 1, from + cap));
          return resolve({ data: page, count: rows.length, error: null });
        },
      };
      return b;
    },
  };
  return { client: client as unknown as SupabaseClient, requests };
}

const rows = Array.from({ length: 7 }, (_, i) => ({ id: `e${i}` }));
const since = new Date('2026-10-31T18:30:00Z');

describe('loadCloseEvents', () => {
  it('scopes to the account, the closing stages and the month, in a stable order', async () => {
    const { client, requests } = fakeSupabase(rows, 1000);
    await loadCloseEvents(client, 'acc-1', ['s-won', 's-lost'], since);
    expect(requests[0]).toMatchObject({
      table: 'deal_stage_events',
      select: 'deal_id, to_stage_id, changed_at',
      selectOpts: { count: 'exact' },
      'eq:account_id': 'acc-1',
      'in:to_stage_id': ['s-won', 's-lost'],
      'gte:changed_at': '2026-10-31T18:30:00.000Z',
      order: [
        ['changed_at', { ascending: true }],
        ['id', { ascending: true }],
      ],
    });
  });

  it('pages until it has every row, even when the server caps pages below the ask', async () => {
    const { client, requests } = fakeSupabase(rows, 3);
    const out = await loadCloseEvents(client, 'acc-1', ['s-won'], since);
    expect(out.map((r) => (r as unknown as { id: string }).id)).toEqual(rows.map((r) => r.id));
    expect(requests.map((r) => r.range)).toEqual([
      [0, 999],
      [3, 1002],
      [6, 1005],
    ]);
  });

  it('makes no request when the pipeline has no Enrolled or Lost stage', async () => {
    const { client, requests } = fakeSupabase(rows, 1000);
    expect(await loadCloseEvents(client, 'acc-1', [], since)).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('throws on a failed read instead of returning an empty list', async () => {
    const { client } = fakeSupabase(rows, 1000, 'permission denied');
    await expect(loadCloseEvents(client, 'acc-1', ['s-won'], since)).rejects.toThrow(
      'permission denied'
    );
  });
});
