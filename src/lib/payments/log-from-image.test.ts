import { describe, expect, it } from 'vitest';

import { paymentMessageForConversation } from './log-from-image';

const msg = { id: 'm1', conversation_id: 'c-8096-a' };

describe('paymentMessageForConversation', () => {
  it('keeps the message for its own conversation', () => {
    expect(paymentMessageForConversation(msg, 'c-8096-a')).toBe(msg);
  });
  it('drops it once another conversation is active', () => {
    expect(paymentMessageForConversation(msg, 'c-8096-b')).toBeNull();
  });
  it('drops it when no conversation is active', () => {
    expect(paymentMessageForConversation(msg, null)).toBeNull();
    expect(paymentMessageForConversation(msg, undefined)).toBeNull();
  });
  it('passes null through', () => {
    expect(paymentMessageForConversation(null, 'c-8096-a')).toBeNull();
  });
});
