import { describe, expect, it } from 'vitest';

import { receiptUploadFailure } from './receipt-message';

describe('receiptUploadFailure', () => {
  it('is an error for cash: the receipt is missing and must be attached before acknowledging', () => {
    const r = receiptUploadFailure('cash', new Error('bucket down'));
    expect(r.level).toBe('error');
    expect(r.message).toMatch(/receipt is missing/i);
    expect(r.message).toMatch(/before .*acknowledg/i);
    expect(r.message).toMatch(/bucket down/);
  });

  it('stays a warning for other methods', () => {
    const r = receiptUploadFailure('upi', new Error('bucket down'));
    expect(r.level).toBe('warning');
    expect(r.message).toMatch(/Payment recorded, but the receipt did not upload/);
  });

  it('copes with a non-Error', () => {
    expect(receiptUploadFailure('upi', 'x').message).toMatch(/unknown error/);
  });
});
