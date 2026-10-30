// KB-CHATLINK-20261030: pure helpers for the /c/[token] chat page (unit-tested).

/** Tokens minted by create_chat_link(): 18 random bytes, base64url, 24 chars. */
export function isChatToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{24}$/.test(token);
}

export type ChatLine = { who: 'lead' | 'bot' | 'counsellor' | 'other'; text: string; ad: string | null; note?: boolean };

// Kuanli's placeholders for an inbound WhatsApp would not hand us (Meta 131051 / 131060, edited or deleted). They
// say "check the WhatsApp Business app", which a counsellor does not have: show what to do instead.
const UNREADABLE = /^(?:Unsupported message type|Message unavailable \(Meta 131060\)|Message content not available in Kuanli)/;
export const UNREADABLE_NOTE =
  'The lead sent something WhatsApp does not pass on to us (for example a view-once photo, a poll or a message they later deleted). We cannot see it here. Ask them on WhatsApp to send it again as text.';

const BANNER = /^\s*🚀 \*Ad Clicked:\* ([^\n]*)\n[\s\S]*?(?:\n🔗[^\n]*)?(?:\n\n|$)/;

/**
 * One message for display. The first inbound of an ad lead carries Kuanli's
 * banner (headline, full ad body, link) before the lead's own words: show the
 * headline as a small "Ad clicked" note and only the lead's text as the bubble.
 */
export function toChatLine(senderType: string, contentType: string, text: string | null): ChatLine {
  const who = senderType === 'customer' ? 'lead' : senderType === 'bot' ? 'bot' : senderType === 'agent' ? 'counsellor' : 'other';
  let body = (text ?? '').trim();
  let ad: string | null = null;
  const m = who === 'lead' ? body.match(BANNER) : null;
  if (m) { ad = m[1].trim(); body = body.slice(m[0].length).trim(); }
  if (who === 'lead' && UNREADABLE.test(body)) return { who, text: UNREADABLE_NOTE, ad, note: true };
  if (!body) body = contentType === 'text' ? '' : `[${contentType}]`;
  return { who, text: body, ad };
}
