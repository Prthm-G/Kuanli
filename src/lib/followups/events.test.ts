import { afterEach, describe, expect, it, vi } from 'vitest';

import { announceFollowUpsChanged, onFollowUpsChanged } from './events';

describe('follow-ups changed signal', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reaches every listener in the tab until it unsubscribes', () => {
    vi.stubGlobal('window', new EventTarget());
    const a = vi.fn();
    const b = vi.fn();
    const offA = onFollowUpsChanged(a);
    const offB = onFollowUpsChanged(b);
    announceFollowUpsChanged();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    announceFollowUpsChanged();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    offB();
  });

  it('is a no-op on the server', () => {
    expect(() => announceFollowUpsChanged()).not.toThrow();
    expect(() => onFollowUpsChanged(() => {})()).not.toThrow();
  });
});
