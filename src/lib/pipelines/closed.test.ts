import { describe, expect, it } from 'vitest';

import { isExitDeal, isExitStage, openDealsSummary } from './closed';

describe('isExitStage', () => {
  it('Lost and Not Interested are exits; every other stage is not', () => {
    expect(isExitStage('Lost')).toBe(true);
    expect(isExitStage('Not Interested')).toBe(true);
    for (const n of [
      'New Lead',
      'Qualified',
      'Application Started',
      'Provisional ID',
      'Form & Documents',
      'Fee Submitted',
      'Enrolled',
      '',
      null,
      undefined,
    ]) {
      expect(isExitStage(n)).toBe(false);
    }
  });
});

describe('isExitDeal', () => {
  it('a deal marked lost, or sitting in an exit stage, is closed', () => {
    expect(isExitDeal({ status: 'lost', stageName: 'Qualified' })).toBe(true);
    expect(isExitDeal({ status: 'open', stageName: 'Not Interested' })).toBe(
      true
    );
    expect(isExitDeal({ status: 'open', stageName: 'Lost' })).toBe(true);
  });
  it('open and won deals in a working stage are not', () => {
    expect(isExitDeal({ status: 'open', stageName: 'Qualified' })).toBe(false);
    expect(isExitDeal({ status: 'won', stageName: 'Enrolled' })).toBe(false);
    expect(isExitDeal({ status: undefined, stageName: undefined })).toBe(false);
  });
});

describe('openDealsSummary', () => {
  it('leaves Lost and Not Interested out of the count and the value', () => {
    expect(
      openDealsSummary([
        { value: 100, stage: { name: 'Qualified' } },
        { value: 50, stage: { name: 'Not Interested' } },
        { value: 25, stage: { name: 'Lost' } },
        { value: null, stage: null },
      ])
    ).toEqual({ count: 2, value: 100 });
  });
});
