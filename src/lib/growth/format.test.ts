import { describe, expect, it } from 'vitest';

import {
  adLabel,
  costPer,
  coverageLine,
  cpeLabel,
  daysSince,
  inr,
  istDate,
  numberLabel,
  regionLabel,
  spendCell,
} from './format';

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

describe('costPer', () => {
  it('divides, or says why not', () => {
    expect(costPer(1000, 4)).toBe('₹250');
    expect(costPer(500, 0)).toBe('none yet');
    expect(costPer(0, 0)).toBe('n/a');
    expect(costPer(null, 3)).toBe('no data');
  });
});

describe('labels', () => {
  it('spend, region and ad', () => {
    expect(spendCell(null)).toBe('no data');
    expect(spendCell(1234.4)).toBe('₹1,234');
    expect(regionLabel('null')).toBe('Unknown');
    expect(regionLabel('Unknown')).toBe('Unknown');
    expect(regionLabel('Punjab region')).toBe('Punjab region');
    expect(
      adLabel({ adId: '1', catalogName: 'A10', metaName: 'x', inCatalog: true })
    ).toBe('A10');
    expect(
      adLabel({
        adId: '81059999',
        catalogName: null,
        metaName: 'Meta name',
        inCatalog: false,
      })
    ).toBe('unknown ad (Meta name) …059999');
    expect(
      adLabel({
        adId: '81059999',
        catalogName: null,
        metaName: null,
        inCatalog: false,
      })
    ).toBe('unknown ad …059999');
  });

  it('coverage line states the cost basis once spend is complete, clamped to the syncable days', () => {
    const name = (c: string | null) => (c === 'PTA' ? 'Patiala' : 'Mohali');
    const pta = (d: number) => ({ adAccountId: '1', branchCode: 'PTA', accountTz: 'America/Los_Angeles', lastDay: '2026-11-26', daysInWindow: d });
    const moh = (d: number) => ({ adAccountId: '2', branchCode: 'MOH', accountTz: 'Asia/Kolkata', lastDay: '2026-11-27', daysInWindow: d });
    expect(coverageLine([pta(28)], name)).toContain('Costs use spend for 28 of 30 chat days, so they read slightly low.');
    expect(coverageLine([pta(29)], name)).toContain('for 28 of 30 chat days');
    expect(coverageLine([pta(29)], name)).not.toContain('29 of 28');
    expect(coverageLine([pta(28), moh(29)], name)).toContain('Costs use spend for Patiala 28 of 30, Mohali 29 of 30 chat days, so they read slightly low.');
    expect(coverageLine([pta(3)], name)).not.toContain('Costs use');
  });

  it('coverage line says how many days are stored', () => {
    const name = (c: string | null) => (c === 'PTA' ? 'Patiala' : c === 'MOH' ? 'Mohali' : 'No branch');
    expect(coverageLine([], name)).toBe('No daily Meta spend stored yet, so spend columns say "no data".');
    expect(coverageLine([
      { adAccountId: '1', branchCode: 'PTA', accountTz: 'America/Los_Angeles', lastDay: '2026-11-26', daysInWindow: 3 },
    ], name)).toBe('Spend stored for 3 of 28 days, last 2026-11-26 (Meta day, Pacific for Patiala). Chats use IST days.');
    expect(coverageLine([
      { adAccountId: '1', branchCode: 'PTA', accountTz: 'America/Los_Angeles', lastDay: '2026-11-26', daysInWindow: 3 },
      { adAccountId: '2', branchCode: 'MOH', accountTz: 'Asia/Kolkata', lastDay: '2026-11-27', daysInWindow: 2 },
    ], name)).toBe('Spend stored for Patiala 3 of 28 days, last 2026-11-26 (Meta day, Pacific); Mohali 2 of 29 days, last 2026-11-27. Chats use IST days.');
  });
});
