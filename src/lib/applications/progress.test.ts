import { describe, it, expect } from 'vitest';

import { computeProgress } from './progress';
import type { RequiredDoc } from './types';

function doc(status: RequiredDoc['status']): RequiredDoc {
  return { docType: 'x', label: 'X', status, documentId: null };
}

describe('computeProgress', () => {
  it('counts verified and received separately', () => {
    const p = computeProgress([
      doc('verified'),
      doc('received'),
      doc('missing'),
      doc('rejected'),
    ]);
    expect(p).toEqual({ verified: 1, received: 1, total: 4, ready: false });
  });

  it('is ready only when everything is verified', () => {
    expect(computeProgress([doc('verified'), doc('verified')]).ready).toBe(
      true
    );
    expect(computeProgress([doc('verified'), doc('received')]).ready).toBe(
      false
    );
  });

  it('is never ready with an empty checklist', () => {
    expect(computeProgress([]).ready).toBe(false);
  });
});
