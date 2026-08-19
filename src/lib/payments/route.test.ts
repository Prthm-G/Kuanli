import { describe, it, expect } from 'vitest';

import {
  describeRoute,
  heldBy,
  inHand,
  overRemitted,
  remitted,
  routeState,
} from './route';
import type { PaymentHop } from './types';

function hop(over: Partial<PaymentHop> = {}): PaymentHop {
  return {
    id: 'h1',
    paymentId: 'p1',
    hopOrder: 1,
    fromParty: 'student',
    toParty: 'skeure',
    movedAt: '2026-08-19T09:00:00.000Z',
    amount: 15000,
    method: 'upi',
    reference: null,
    status: 'settled',
    note: null,
    ...over,
  };
}

/** The shape this feature exists for: 15,000 in, 12,000 on to the university. */
const inbound = hop({
  id: 'a',
  hopOrder: 1,
  fromParty: 'student',
  toParty: 'skeure',
  amount: 15000,
});
const outbound = hop({
  id: 'b',
  hopOrder: 2,
  fromParty: 'skeure',
  toParty: 'university',
  amount: 12000,
});

describe('inHand', () => {
  it('is zero before anything is recorded', () => {
    expect(inHand([])).toBe(0);
  });

  it('holds the full amount once it arrives and before it is remitted', () => {
    expect(inHand([inbound])).toBe(15000);
  });

  it('leaves only the commission once the onward leg settles', () => {
    expect(inHand([inbound, outbound])).toBe(3000);
  });

  it('ignores a leg that has not settled', () => {
    const pending = { ...outbound, status: 'pending' as const, movedAt: null };
    // The remittance is intended but has not happened, so we still hold it all.
    expect(inHand([inbound, pending])).toBe(15000);
  });

  it('ignores a failed leg', () => {
    const failed = { ...outbound, status: 'failed' as const };
    expect(inHand([inbound, failed])).toBe(15000);
  });
});

describe('heldBy', () => {
  it('tracks any party, not just us', () => {
    expect(heldBy([inbound, outbound], 'university')).toBe(12000);
    // The student sent money out and received none.
    expect(heldBy([inbound], 'student')).toBe(-15000);
  });
});

describe('remitted', () => {
  it('counts only settled money that reached the university', () => {
    expect(remitted([inbound, outbound])).toBe(12000);
    expect(remitted([inbound])).toBe(0);
    expect(remitted([inbound, { ...outbound, status: 'sent' as const }])).toBe(
      0
    );
  });
});

describe('routeState', () => {
  it('reports an unrecorded route rather than pretending it settled', () => {
    expect(routeState([])).toBe('unrecorded');
  });

  it('flags a failed leg above everything else', () => {
    const failed = { ...outbound, status: 'failed' as const };
    expect(routeState([inbound, failed])).toBe('failed');
  });

  it('says held while the money is with us', () => {
    expect(routeState([inbound])).toBe('held');
    expect(
      routeState([
        inbound,
        { ...outbound, status: 'pending' as const, movedAt: null },
      ])
    ).toBe('held');
  });

  it('says settled only when every leg is done and nothing is left with us', () => {
    const full = { ...outbound, amount: 15000 };
    expect(routeState([inbound, full])).toBe('settled');
  });

  it('still says held when a commission is legitimately retained', () => {
    // Both legs settled, but 3,000 stays with us. That is not "settled" from a
    // float point of view, and calling it so would hide the money we hold.
    expect(routeState([inbound, outbound])).toBe('held');
  });

  it('says in transit when a leg is sent and nothing is sitting with us', () => {
    const sent = hop({
      id: 'c',
      fromParty: 'student',
      toParty: 'university',
      status: 'sent',
    });
    expect(routeState([sent])).toBe('in_transit');
  });
});

describe('describeRoute', () => {
  it('renders the chain in hop order', () => {
    expect(describeRoute([outbound, inbound])).toBe(
      'student → skeure → university'
    );
  });

  it('is empty with no hops', () => {
    expect(describeRoute([])).toBe('');
  });
});

describe('overRemitted', () => {
  it('catches remitting more than came in', () => {
    const tooMuch = { ...outbound, amount: 16000 };
    expect(overRemitted([inbound, tooMuch], 15000)).toBe(true);
  });

  it('accepts remitting the whole payment', () => {
    expect(overRemitted([inbound, { ...outbound, amount: 15000 }], 15000)).toBe(
      false
    );
  });
});
