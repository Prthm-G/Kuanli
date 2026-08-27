/**
 * Route hops: where a payment physically went (migration 057).
 *
 * A payment is not one event. A student pays Skeure, Skeure remits to the
 * university, and between those two moments Skeure is holding money. These
 * helpers answer "who has it right now" from the hop list.
 *
 * Commission is derived here and in the `payment_ledger` RPC, never stored.
 * A stored figure drifts the moment a hop is corrected, and then two numbers
 * disagree with nothing to say which is right.
 */

import { round, sum } from './totals';
import type { PaymentHop, RouteParty } from './types';

/** Only settled legs move money. Pending and failed ones are intentions. */
function settled(hops: PaymentHop[]): PaymentHop[] {
  return hops.filter((h) => h.status === 'settled');
}

/** What a party has received minus what it has sent on, across these hops. */
export function heldBy(hops: PaymentHop[], party: RouteParty): number {
  const s = settled(hops);
  return round(
    sum(s.filter((h) => h.toParty === party).map((h) => h.amount)) -
      sum(s.filter((h) => h.fromParty === party).map((h) => h.amount))
  );
}

/**
 * Money that reached us and has not gone out again: the float plus whatever we
 * keep. Matches the RPC's `in_hand` exactly, so the drawer and the ledger
 * cannot disagree.
 */
export function inHand(hops: PaymentHop[]): number {
  return heldBy(hops, 'skeure');
}

/** Settled money that has reached the university. */
export function remitted(hops: PaymentHop[]): number {
  return sum(
    settled(hops)
      .filter((h) => h.toParty === 'university')
      .map((h) => h.amount)
  );
}

export type RouteState =
  | 'unrecorded'
  | 'in_transit'
  | 'held'
  | 'settled'
  | 'failed';

/**
 * One payment's route, summarised for a chip.
 *
 *   unrecorded — nobody has said where it went. Not an error: the hop trail is
 *                optional, and a payment with no hops is still on the ledger.
 *   failed     — some leg failed and needs attention. Wins over everything
 *                else, because it is the only state that needs a human.
 *   in_transit — a leg has been sent but not confirmed.
 *   held       — it reached us and has not been remitted onward.
 *   settled    — every leg is settled and nothing is sitting with us.
 */
export function routeState(hops: PaymentHop[]): RouteState {
  if (hops.length === 0) return 'unrecorded';
  if (hops.some((h) => h.status === 'failed')) return 'failed';
  if (hops.some((h) => h.status === 'pending' || h.status === 'sent'))
    return inHand(hops) > 0 ? 'held' : 'in_transit';
  return inHand(hops) > 0 ? 'held' : 'settled';
}

export const ROUTE_STATE_LABEL: Record<RouteState, string> = {
  unrecorded: 'Route not recorded',
  in_transit: 'In transit',
  held: 'Held by us',
  settled: 'Settled',
  failed: 'Leg failed',
};

/** "student → skeure → university", for a compact route summary. */
export function describeRoute(hops: PaymentHop[]): string {
  if (hops.length === 0) return '';
  const ordered = [...hops].sort((a, b) => a.hopOrder - b.hopOrder);
  const parties: RouteParty[] = [ordered[0].fromParty];
  for (const h of ordered) parties.push(h.toParty);
  return parties.join(' → ');
}

/**
 * Legs that claim to move more than the payment they belong to. Recording a
 * remittance larger than what came in is a typo every time, and it silently
 * turns the commission negative if nothing catches it.
 */
export function overRemitted(
  hops: PaymentHop[],
  paymentAmount: number
): boolean {
  return remitted(hops) > round(paymentAmount);
}
