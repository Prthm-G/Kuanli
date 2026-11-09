import { describe, expect, it } from 'vitest';

import { applyContactTab } from './tab-filter';

/** Records the PostgREST filters a query would send. */
function recorder() {
  const calls: unknown[][] = [];
  const q = {
    calls,
    like(column: string, pattern: string) {
      calls.push(['like', column, pattern]);
      return q;
    },
    not(column: string, operator: string, value: unknown) {
      calls.push(['not', column, operator, value]);
      return q;
    },
  };
  return q;
}

describe('applyContactTab', () => {
  it('adds no filter on All', () => {
    const q = recorder();
    expect(applyContactTab(q, 'all')).toBe(q);
    expect(q.calls).toEqual([]);
  });

  it('filters Leads on the server by the temporary LD- roll number', () => {
    const q = recorder();
    applyContactTab(q, 'leads');
    expect(q.calls).toEqual([['like', 'roll_number', 'LD-%']]);
  });

  it('filters Enrolled on the server to contacts with a university', () => {
    const q = recorder();
    applyContactTab(q, 'enrolled');
    expect(q.calls).toEqual([['not', 'university', 'is', null]]);
  });
});
