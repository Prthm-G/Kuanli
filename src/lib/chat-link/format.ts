// KB-CHATLINK-20261030: pure helpers for the /c/[token] chat page (unit-tested).

/** Tokens minted by create_chat_link(): 18 random bytes, base64url, 24 chars. */
export function isChatToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{24}$/.test(token);
}

export type ChatLine = { who: 'lead' | 'bot' | 'counsellor' | 'other'; text: string; ad: string | null };

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
  if (!body) body = contentType === 'text' ? '' : `[${contentType}]`;
  return { who, text: body, ad };
}
