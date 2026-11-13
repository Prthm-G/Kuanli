import { describe, expect, it } from 'vitest';

import { paymentWhoWhat } from './payment-detail';

describe('paymentWhoWhat', () => {
  it('shows type, paid to and collected by', () => {
    expect(
      paymentWhoWhat({
        head: 'semester',
        receivedBy: 'university',
        collectedByName: 'Counsellor A',
      })
    ).toBe('Tuition · paid to University · collected by Counsellor A');
  });
  it('omits what is unknown', () => {
    expect(
      paymentWhoWhat({ head: 'other', receivedBy: null, collectedByName: null })
    ).toBe('Other');
  });
});
