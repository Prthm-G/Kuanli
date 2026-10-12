import { describe, expect, it } from 'vitest';

import { snapshotBody } from './test-fixtures';
import { MAX_SNAPSHOT_BYTES, validateSnapshot } from './validate';

const run = (body: unknown) => validateSnapshot(JSON.stringify(body));
const withPayload = (patch: Record<string, unknown>) => {
  const b = snapshotBody();
  return { ...b, payload: { ...b.payload, ...patch } };
};

describe('validateSnapshot', () => {
  it('accepts a well-formed snapshot (13-digit ad ids are not phones)', () => {
    expect(run(snapshotBody()).ok).toBe(true);
  });

  it('stores only known fields', () => {
    const r = run(withPayload({ students: [{ name: 'x' }] }));
    expect(r.ok && 'students' in r.value.payload).toBe(false);
  });

  it('rejects a bad envelope, including calendar-impossible dates', () => {
    expect(run(snapshotBody({ account_id: 'nope' })).ok).toBe(false);
    expect(run(snapshotBody({ snapshot_date: '2026-02-31' })).ok).toBe(false);
    expect(validateSnapshot('not json').ok).toBe(false);
  });

  it('rejects a wrong version or a malformed section', () => {
    expect(run(withPayload({ v: 2 }))).toEqual({
      ok: false,
      error: 'payload.v must be 1',
    });
    expect(run(withPayload({ cells: [{ cell: 'Control' }] })).ok).toBe(false);
  });

  it('requires small counts to stay suppressed', () => {
    const r = run(
      withPayload({
        cells: [{ cell: 'Control', spend: 1, conversations: 1, enrolled: 2 }],
      })
    );
    expect(r).toEqual({
      ok: false,
      error: 'cells[0].enrolled must be suppressed as "<3"',
    });
  });

  it('refuses phone- or email-shaped values, spaced, dashed or JSON-escaped', () => {
    const blocker = (text: string) =>
      withPayload({ blockers: [{ text, owner: 'x', since: null }] });
    expect(run(blocker('call 98765 43210')).ok).toBe(false);
    expect(run(blocker('call +91-98765-43210')).ok).toBe(false);
    expect(
      run(withPayload({ seo: { status: 'ask a@b.com', checked: null } })).ok
    ).toBe(false);
    const escaped = JSON.stringify(
      withPayload({ seo: { status: 'ask a@b.com', checked: null } })
    ).replace('@', '\\u0040');
    expect(validateSnapshot(escaped).ok).toBe(false);
  });

  it('refuses an oversize body', () => {
    expect(validateSnapshot('x'.repeat(MAX_SNAPSHOT_BYTES + 1))).toEqual({
      ok: false,
      error: 'body too large',
    });
  });
});
