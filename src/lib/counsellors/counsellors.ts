import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * A counsellor's rotation entry (the `counsellors` row: WhatsApp number,
 * branch, Telegram join, active), next to their Kuanli login. From R2
 * (migration 098) an admin adds both in one step from Add member, through
 * `add_counsellor`, and turns rotation on and off with
 * `set_counsellor_active`. A new entry stays inactive until the counsellor
 * joins the Telegram leads bot, so no lead goes to someone who cannot see the
 * ping.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `add_counsellor`'s rule for the WhatsApp number: 91, then an Indian mobile. */
export const WA_NUMBER_RE = /^91[6-9][0-9]{9}$/;
/** The database's rule for `counsellors.display_name` (it goes in the ping). */
export const DISPLAY_NAME_RE = /^[A-Za-z][A-Za-z .]{0,11}$/;
const BOT_USERNAME_RE = /^[A-Za-z0-9_]{5,32}$/;

/**
 * An Indian mobile number as `91XXXXXXXXXX`, or null. Takes the 10 digits on
 * their own, with the 91 country code, or with a leading trunk 0; spaces,
 * dashes and "+" are ignored.
 */
export function normalizeWaNumber(input: string): string | null {
  const d = input.replace(/[\s\-+().]/g, '');
  if (!/^\d+$/.test(d)) return null;
  let out: string | null = null;
  if (d.length === 10) out = `91${d}`;
  else if (d.length === 12 && d.startsWith('91')) out = d;
  else if (d.length === 11 && d.startsWith('0')) out = `91${d.slice(1)}`;
  return out && WA_NUMBER_RE.test(out) ? out : null;
}

/** First word of the member's name, cut to what the ping allows. */
export function defaultDisplayName(fullName: string): string {
  const first = fullName.trim().split(/\s+/)[0] ?? '';
  return first.replace(/[^A-Za-z.]/g, '').slice(0, 12);
}

export function isValidDisplayName(name: string): boolean {
  return DISPLAY_NAME_RE.test(name);
}

/** The Telegram deep link that joins the leads bot, or null without a bot. */
export function telegramJoinLink(
  botUsername: string | null | undefined,
  startCode: string
): string | null {
  const bot = (botUsername ?? '').trim().replace(/^@/, '');
  if (!BOT_USERNAME_RE.test(bot)) return null;
  return `https://t.me/${bot}?start=${encodeURIComponent(startCode)}`;
}

export interface AddCounsellorInput {
  profileId: string;
  branchId: string;
  /** As typed; normalised here. */
  waNumber: string;
  displayName: string;
}

export type AddCounsellorResult =
  | {
      ok: true;
      counsellorId: string;
      /** The Telegram join code; null once a linked entry has joined. */
      startCode: string | null;
      linked: boolean;
    }
  | { ok: false; error: string };

export async function addCounsellor(
  db: SupabaseClient,
  input: AddCounsellorInput
): Promise<AddCounsellorResult> {
  if (!UUID.test(input.profileId)) return { ok: false, error: 'Invalid member' };
  if (!UUID.test(input.branchId)) return { ok: false, error: 'Pick a branch' };
  const wa = normalizeWaNumber(input.waNumber);
  if (!wa) return { ok: false, error: 'Enter a 10-digit Indian mobile number' };
  const name = input.displayName.trim();
  if (!isValidDisplayName(name)) {
    return {
      ok: false,
      error: 'Display name: up to 12 letters, starting with a letter (spaces and dots allowed)',
    };
  }

  const { data, error } = await db.rpc('add_counsellor', {
    p_profile: input.profileId,
    p_branch: input.branchId,
    p_wa_number: wa,
    p_display_name: name,
  });
  if (error) {
    return {
      ok: false,
      error:
        error.code === '42501'
          ? 'Only an admin can add a counsellor.'
          : error.message || 'Could not add them to the lead rotation',
    };
  }
  // RETURNS TABLE comes back as an array of one row.
  const row = (Array.isArray(data) ? data[0] : data) as
    | { counsellor_id?: string; telegram_start_code?: string | null; linked?: boolean }
    | null
    | undefined;
  if (!row?.counsellor_id) {
    return { ok: false, error: 'Could not add them to the lead rotation' };
  }
  return {
    ok: true,
    counsellorId: row.counsellor_id,
    startCode: row.telegram_start_code ?? null,
    linked: row.linked === true,
  };
}

export type ToggleResult = { ok: true } | { ok: false; error: string };

/** Turn a counsellor's lead rotation on or off. */
export async function setCounsellorActive(
  db: SupabaseClient,
  counsellorId: string,
  on: boolean
): Promise<ToggleResult> {
  if (!UUID.test(counsellorId)) return { ok: false, error: 'Invalid counsellor' };
  const { error } = await db.rpc('set_counsellor_active', {
    p_counsellor: counsellorId,
    p_on: on,
  });
  if (!error) return { ok: true };
  if (error.code === '42501') {
    return { ok: false, error: 'Only an admin can change who takes leads.' };
  }
  // 098 raises it as SQLSTATE 22023; the message is what tells it apart.
  if (/has not joined Telegram/i.test(error.message ?? '')) {
    return {
      ok: false,
      error: 'They have not joined the Telegram leads bot yet. Send them their join link first.',
    };
  }
  return { ok: false, error: error.message || 'Could not change who takes leads' };
}
