import type { PaymentMethod } from './types';

/**
 * What to tell the user when the receipt upload fails after the payment row
 * was saved. A cash payment has no other evidence, so it is an error, not a
 * passing warning.
 */
export function receiptUploadFailure(
  method: PaymentMethod,
  error: unknown
): { level: 'error' | 'warning'; message: string } {
  const why = error instanceof Error ? error.message : 'unknown error';
  if (method === 'cash') {
    return {
      level: 'error',
      message: `Payment recorded, but the receipt is missing (${why}). Attach it before this payment is acknowledged.`,
    };
  }
  return {
    level: 'warning',
    message: `Payment recorded, but the receipt did not upload: ${why}`,
  };
}
