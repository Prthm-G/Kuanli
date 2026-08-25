/**
 * Authentication for the internal /api/bot/* surface (KB-COURSEINFO-R5-53).
 *
 * Extracted verbatim from api/bot/course-info/route.ts the day a second bot
 * route appeared (report-conversions). Auth logic held in two route files is
 * the exact two-places defect this project keeps rediscovering, and auth is
 * the worst place to host it: the copies would agree until precisely the
 * moment one was hardened and the other was not.
 *
 * The design constraints these encode (full rationale in course-info):
 *  - HMAC preferred; n8n cannot compute it (no `crypto` in its Code sandbox),
 *    so a constant-time shared-secret bearer is the accepted fallback.
 *  - Anything carrying Cloudflare's headers came through the public tunnel and
 *    is refused with a 404, because /api/bot/* is compose-network-internal and
 *    a path that should not be publicly known should not confirm it exists.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_SKEW_MS = 5 * 60 * 1000;

export function constantTimeEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which is itself a leak of one
  // bit; compare lengths first and always in constant time after that.
  return x.length === y.length && timingSafeEqual(x, y);
}

export function verifySignature(
  rawBody: string,
  timestamp: string,
  signature: string
): boolean {
  const secret = process.env.N8N_WEBHOOK_SECRET;
  if (!secret) return false;

  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SKEW_MS)
    return false;

  const expected = `sha256=${createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex')}`;

  return constantTimeEquals(expected, signature);
}

export function verifySharedSecret(provided: string): boolean {
  const secret = process.env.N8N_WEBHOOK_SECRET;
  if (!secret || !provided) return false;
  return constantTimeEquals(secret, provided);
}

export function cameFromPublicInternet(request: Request): boolean {
  return (
    request.headers.has('cf-ray') || request.headers.has('cf-connecting-ip')
  );
}
