import { describe, expect, it, vi } from 'vitest';

import { latestOnly } from './latest-only';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('latestOnly', () => {
  it('drops a slow older response that lands after a newer one', async () => {
    const gate = latestOnly();
    const apply = vi.fn();
    const a = deferred<string>();
    const b = deferred<string>();
    const runA = gate.run(() => a.promise, apply); // the slow poll
    const runB = gate.run(() => b.promise, apply); // after Not interested
    b.resolve('B');
    await runB;
    a.resolve('A');
    await runA;
    expect(apply.mock.calls).toEqual([['B']]);
  });

  it('a claim taken elsewhere (the resync fetch) supersedes a refresh in flight', async () => {
    const gate = latestOnly();
    const apply = vi.fn();
    const a = deferred<string>();
    const runA = gate.run(() => a.promise, apply);
    const resync = gate.claim();
    a.resolve('A');
    await runA;
    expect(apply).not.toHaveBeenCalled();
    expect(gate.isLatest(resync)).toBe(true);
  });

  it('applies when nothing newer started', async () => {
    const gate = latestOnly();
    const apply = vi.fn();
    await gate.run(async () => 'only', apply);
    expect(apply).toHaveBeenCalledWith('only');
  });
});
