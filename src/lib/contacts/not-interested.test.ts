import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { loadNotInterestedContacts } from './not-interested';

/** Records the query the helper builds and answers with `rows`. */
function recorder(rows: Record<string, unknown>[], count = rows.length) {
  const calls: [string, ...unknown[]][] = [];
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'or', 'order', 'range'])
    b[m] = (...a: unknown[]) => (calls.push([m, ...a]), b);
  b.then = (ok: (v: unknown) => unknown) =>
    Promise.resolve({ data: rows, count, error: null }).then(ok);
  const db = {
    from: (t: string) => (calls.push(['from', t]), b),
  } as unknown as SupabaseClient;
  return { db, calls };
}

describe('loadNotInterestedContacts', () => {
  it('filters on the server by a deal in the Not Interested stage, paged, with an exact count', async () => {
    const { db, calls } = recorder(
      [
        {
          id: 'c1',
          name: 'A',
          deals: [{ pipeline_stages: { name: 'Not Interested' } }],
        },
      ],
      7
    );
    const res = await loadNotInterestedContacts(db, { from: 25, to: 49 });
    expect(calls).toContainEqual(['from', 'contacts']);
    expect(calls).toContainEqual([
      'select',
      '*, deals!inner(pipeline_stages!inner(name))',
      { count: 'exact' },
    ]);
    expect(calls).toContainEqual([
      'eq',
      'deals.pipeline_stages.name',
      'Not Interested',
    ]);
    expect(calls).toContainEqual(['range', 25, 49]);
    // created_at ties broken by id, so paging is stable.
    const orders = calls.filter((c) => c[0] === 'order');
    expect(orders).toEqual([
      ['order', 'created_at', { ascending: false }],
      ['order', 'id', { ascending: true }],
    ]);
    expect(res).toEqual({
      rows: [{ id: 'c1', name: 'A' }],
      count: 7,
      error: null,
    });
  });

  it('applies the search and the tag filter on the server too', async () => {
    const { db, calls } = recorder([]);
    await loadNotInterestedContacts(db, {
      from: 0,
      to: 24,
      term: 'ra',
      tagIds: ['t1', 't2'],
    });
    expect(calls).toContainEqual([
      'or',
      'name.ilike.%ra%,phone.ilike.%ra%,email.ilike.%ra%',
    ]);
    expect(calls).toContainEqual([
      'select',
      '*, deals!inner(pipeline_stages!inner(name)), contact_tags!inner(tag_id)',
      { count: 'exact' },
    ]);
    expect(calls).toContainEqual(['in', 'contact_tags.tag_id', ['t1', 't2']]);
  });
});
