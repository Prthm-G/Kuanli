import { describe, expect, it } from 'vitest';
import { JOURNEY_STEPS, journeyPosition, pickCurrentDeal } from './journey';

describe('journeyPosition', () => {
  it.each([
    ['New Lead', 0],
    ['Engaged', 0],
    ['Qualified', 0],
    ['Counselor Active', 0],
    ['Application Started', 1],
    ['Provisional ID', 2],
    ['Form & Documents', 3],
    ['Fee Submitted', 4],
    ['Enrolled', 5],
  ])('%s is step %i', (name, step) =>
    expect(journeyPosition(name)).toEqual({ step, closed: null })
  );
  it('Lost and Not Interested are a closed end', () => {
    expect(journeyPosition('Lost')).toEqual({ step: null, closed: 'Lost' });
    expect(journeyPosition('Not Interested')).toEqual({
      step: null,
      closed: 'Not Interested',
    });
  });
  it('unknown, null and prototype keys map to nothing', () => {
    for (const n of ['Sales Call', null, undefined, 'constructor', 'toString'])
      expect(journeyPosition(n)).toEqual({ step: null, closed: null });
  });
  it('has six steps', () => expect(JOURNEY_STEPS).toHaveLength(6));
});

describe('pickCurrentDeal', () => {
  const d = (name: string, updated_at: string) => ({
    stage: { name },
    updated_at,
  });
  it('prefers the furthest open deal', () => {
    expect(
      pickCurrentDeal([
        d('Qualified', '2026-11-27'),
        d('Provisional ID', '2026-11-01'),
        d('Lost', '2026-11-28'),
      ])?.stage.name
    ).toBe('Provisional ID');
  });
  it('breaks a tie by the latest update', () => {
    expect(
      pickCurrentDeal([
        d('Qualified', '2026-11-01'),
        d('Qualified', '2026-11-20'),
      ])?.updated_at
    ).toBe('2026-11-20');
  });
  it('falls back to the latest closed deal', () => {
    expect(
      pickCurrentDeal([
        d('Lost', '2026-11-01'),
        d('Not Interested', '2026-11-20'),
      ])?.stage.name
    ).toBe('Not Interested');
  });
  it('is null with no deals', () => expect(pickCurrentDeal([])).toBeNull());
});
