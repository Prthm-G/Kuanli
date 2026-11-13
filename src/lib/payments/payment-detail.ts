import { HEAD_LABEL, PARTY_LABEL, type Payment } from './types';

/** "Tuition · paid to Office · collected by Sam": what the money is for and who has it. */
export function paymentWhoWhat(
  p: Pick<Payment, 'head' | 'receivedBy' | 'collectedByName'>
): string {
  return [
    HEAD_LABEL[p.head],
    p.receivedBy ? `paid to ${PARTY_LABEL[p.receivedBy]}` : null,
    p.collectedByName ? `collected by ${p.collectedByName}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
