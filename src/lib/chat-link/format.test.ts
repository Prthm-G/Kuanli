import { describe, expect, it } from 'vitest';
import { isChatToken, toChatLine, UNREADABLE_NOTE } from './format';

describe('isChatToken', () => {
  it('accepts a 24-char base64url token', () => expect(isChatToken('aB3_-xYz09aB3_-xYz09aB3_')).toBe(true));
  it('rejects short, long and odd tokens', () => {
    expect(isChatToken('short')).toBe(false);
    expect(isChatToken('a'.repeat(25))).toBe(false);
    expect(isChatToken("aB3_-xYz09aB3_-xYz09aB3'")).toBe(false);
  });
});

describe('toChatLine', () => {
  const banner = '🚀 *Ad Clicked:* LPU Online: study while you work\nWorking full-time? MBA, MCA...\n🔗 https://fb.me/x\n\nHi! I want details of LPU Online courses.';
  it('splits the ad banner from the lead text', () => {
    expect(toChatLine('customer', 'text', banner)).toEqual({ who: 'lead', text: 'Hi! I want details of LPU Online courses.', ad: 'LPU Online: study while you work' });
  });
  it('keeps a plain lead message', () => expect(toChatLine('customer', 'text', 'BA fees?')).toEqual({ who: 'lead', text: 'BA fees?', ad: null }));
  it('labels bot and counsellor', () => {
    expect(toChatLine('bot', 'text', 'Hi').who).toBe('bot');
    expect(toChatLine('agent', 'text', 'Hello').who).toBe('counsellor');
  });
  it('shows media without text as its type', () => expect(toChatLine('customer', 'image', null).text).toBe('[image]'));
  it('never treats a bot message as a banner', () => expect(toChatLine('bot', 'text', banner).ad).toBeNull());
});

describe('unreadable inbound', () => {
  it('turns the 131051 placeholder into a note', () => {
    expect(toChatLine('customer', 'text', 'Unsupported message type (Meta 131051). Check the WhatsApp Business app.')).toEqual({ who: 'lead', text: UNREADABLE_NOTE, ad: null, note: true });
  });
  it('turns the 131060 and deleted placeholders into the note', () => {
    expect(toChatLine('customer', 'text', 'Message unavailable (Meta 131060). They tried to reach us; follow up from the WhatsApp Business app.').note).toBe(true);
    expect(toChatLine('customer', 'text', 'Message content not available in Kuanli (unsupported, edited or deleted on WhatsApp). Check the WhatsApp Business app.').note).toBe(true);
  });
  it('leaves a lead who types the words alone mid-sentence', () => expect(toChatLine('customer', 'text', 'is this an Unsupported message type?').note).toBeUndefined());
});
