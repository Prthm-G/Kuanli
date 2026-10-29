import { describe, expect, it } from 'vitest';
import { whatsappChatUrl } from './wa-link';

describe('whatsappChatUrl', () => {
  it('strips everything but digits', () => {
    expect(whatsappChatUrl('+91 95922-00021')).toBe(
      'https://wa.me/919592200021'
    );
    expect(whatsappChatUrl('919592200021')).toBe('https://wa.me/919592200021');
  });
  it('null for empty, too short or too long', () => {
    expect(whatsappChatUrl('')).toBeNull();
    expect(whatsappChatUrl(null)).toBeNull();
    expect(whatsappChatUrl('12345')).toBeNull();
    expect(whatsappChatUrl('1234567890123456')).toBeNull();
    expect(whatsappChatUrl('javascript:alert(1)')).toBeNull();
  });
});
