import { describe, expect, it } from 'vitest';

import { cpeLabel, daysSince, inr, istDate, numberLabel } from './format';

describe('growth format', () => {
  it('inr groups digits the Indian way', () => {
    expect(inr(1439084.4)).toBe('₹14,39,084');
  });

  it('cpeLabel separates "spent, nothing enrolled" from "nothing spent"', () => {
    expect(cpeLabel(14390, 1659.4)).toBe('₹1,659');
    expect(cpeLabel(14390, null)).toBe('no enrolments');
    expect(cpeLabel(0, null)).toBe('n/a');
  });

  it('daysSince counts whole days and tolerates a missing timestamp', () => {
    const now = new Date('2026-10-12T12:00:00Z');
    expect(daysSince('2026-10-01T11:40:58Z', now)).toBe(11);
    expect(daysSince(null, now)).toBeNull();
  });

  it('numberLabel marks numbers no longer configured as retired', () => {
    expect(numberLabel('1320822847785161', '+91 79019 79019')).toBe(
      '+91 79019 79019'
    );
    expect(numberLabel('110485318348695', null)).toBe('retired number (…8695)');
  });

  it('istDate shows the IST calendar day, not the UTC one', () => {
    expect(istDate('2026-10-01T20:00:00Z')).toBe('2026-10-02');
    expect(istDate(null)).toBe('—');
  });
});
