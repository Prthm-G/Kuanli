import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { contactListQuery, withoutTagJoin } from './list-query';

/** Records every builder call in order. */
function recorder() {
  const calls: unknown[][] = [];
  const builder: Record<string, (...args: unknown[]) => unknown> = {};
  for (const m of ['select', 'order', 'range', 'in', 'like', 'not', 'or']) {
    builder[m] = (...args: unknown[]) => {
      calls.push([m, ...args]);
      return builder;
    };
  }
  const client = {
    from(table: string) {
      calls.push(['from', table]);
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

const base = { from: 25, to: 49, term: '' };

describe('contactListQuery', () => {
  it('without tags: plain select, newest first with an id tie-breaker, paged', () => {
    const { client, calls } = recorder();
    contactListQuery(client, { ...base, tab: 'all', tagIds: [] });
    expect(calls).toEqual([
      ['from', 'contacts'],
      ['select', '*', { count: 'exact' }],
      ['order', 'created_at', { ascending: false }],
      ['order', 'id', { ascending: true }],
      ['range', 25, 49],
    ]);
  });

  it('tags with a tab: inner join on contact_tags, filter on the embedded tag_id, then the tab', () => {
    const { client, calls } = recorder();
    contactListQuery(client, { ...base, tab: 'leads', tagIds: ['t1', 't2'] });
    expect(calls).toEqual([
      ['from', 'contacts'],
      ['select', '*, contact_tags!inner(tag_id)', { count: 'exact' }],
      ['order', 'created_at', { ascending: false }],
      ['order', 'id', { ascending: true }],
      ['range', 25, 49],
      ['in', 'contact_tags.tag_id', ['t1', 't2']],
      ['like', 'roll_number', 'LD-%'],
    ]);
  });

  it('adds the name/phone/email search', () => {
    const { client, calls } = recorder();
    contactListQuery(client, { ...base, tab: 'enrolled', tagIds: [], term: 'kaur' });
    expect(calls.slice(-2)).toEqual([
      ['not', 'university', 'is', null],
      ['or', 'name.ilike.%kaur%,phone.ilike.%kaur%,email.ilike.%kaur%'],
    ]);
  });
});

describe('withoutTagJoin', () => {
  it('drops the contact_tags join column and keeps everything else', () => {
    const rows = [
      { id: 'c1', name: 'A', contact_tags: [{ tag_id: 't1' }] },
      { id: 'c2', name: 'B' },
    ];
    expect(withoutTagJoin(rows)).toEqual([
      { id: 'c1', name: 'A' },
      { id: 'c2', name: 'B' },
    ]);
    // the input is not mutated
    expect(rows[0]).toHaveProperty('contact_tags');
  });
});
