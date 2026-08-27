/**
 * Meta Conversions API for Business Messaging (KB-CAPI-R5-41).
 *
 * Migration 061 captures `ctwa_clid` when a lead arrives from a click-to-
 * WhatsApp ad. This module is the return leg: it reports what that lead went on
 * to do, so Meta's optimiser learns which ads produce admissions instead of
 * only which ads produce taps.
 *
 * THE CONTRACT (verified against Meta's Business Messaging onboarding guide,
 * not from memory - this project has been burned twice by asserting a live
 * product fact from training data):
 *
 *   POST {GRAPH}/{dataset_id}/events
 *   {
 *     "data": [{
 *       "event_name":        "Lead" | "Purchase" | ...,
 *       "event_time":        <unix seconds>,
 *       "action_source":     "business_messaging",   // NOT "website"
 *       "messaging_channel": "whatsapp",
 *       "event_id":          "<dedup key>",
 *       "user_data": {
 *         "whatsapp_business_account_id": "<waba_id>",
 *         "ctwa_clid":                    "<click id>"   // NEVER hashed
 *       },
 *       "custom_data": { "currency": "INR", "value": 12345 }
 *     }],
 *     "partner_agent": "kuanli"
 *   }
 *
 * Three details in there are load-bearing and easy to get wrong:
 *
 *   1. `ctwa_clid` is explicitly "do not hash". Every other user identifier in
 *      the Conversions API (email, phone) MUST be SHA-256 hashed, so the
 *      instinct to hash is strong and wrong. A hashed click id matches nothing
 *      and fails silently - Meta accepts the event and attributes it nowhere.
 *
 *   2. `action_source` is "business_messaging", not "website". Web events
 *      additionally require `client_user_agent` and `event_source_url`;
 *      business-messaging events require neither. Sending "website" makes Meta
 *      reject the event for missing fields that do not exist here.
 *
 *   3. The target is a DATASET id, not a pixel id. It is minted per WABA and is
 *      not interchangeable with the ad account's pixel.
 *
 * THE 7-DAY CLIFF. Meta rejects the ENTIRE request - processing none of it - if
 * ANY event_time in the batch is more than 7 days old. One stale row therefore
 * discards every good row sent with it. Staleness is checked per event BEFORE
 * the call, and stale events are recorded as 'skipped' rather than allowed to
 * poison a batch.
 *
 * WHY THERE IS NO PRIMARY-CONFIG FALLBACK. `getConfigForConversation` falls
 * back to the account's primary config when a conversation carries no
 * phone_number_id, which is right for a reply: sending from the wrong number is
 * visible and recoverable. It is wrong here. A `ctwa_clid` is only meaningful
 * against the WABA that minted it, this account has two connected WABAs, and
 * the row flagged `is_primary` is NOT the one currently receiving live traffic.
 * Reporting against the wrong WABA is not an error Meta returns - it is an
 * event that lands nowhere and looks, from every dashboard, exactly like a lead
 * who never converted. So this module resolves strictly and refuses rather than
 * guesses.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { META_API_BASE } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';

/**
 * The events this system actually sends. Meta's taxonomy is larger; this is
 * deliberately the narrow set the admissions funnel maps onto, so an unmapped
 * stage cannot be reported as a guess.
 */
export type ConversionEventName =
  | 'LeadSubmitted' // CRM 'Qualified'
  | 'InitiateCheckout' // CRM 'Application Started' (migration 075)
  | 'Purchase'; // CRM 'Enrolled'

/** Meta's hard limit on how far back an event_time may be. */
export const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Reported money is always rupees; Skeure prices in INR and nothing else. */
export const DEFAULT_CURRENCY = 'INR';

export type ConversionSkipReason =
  /** Not from an ad. The overwhelming majority of conversations. Not a fault. */
  | 'organic'
  /** Conversation has no phone_number_id, so the minting WABA is unknowable. */
  | 'no_phone_number_id'
  /** The resolved config has no waba_id. */
  | 'no_waba_id'

  /** Older than Meta's 7-day window. Unreportable, permanently. */
  | 'event_too_old'
  /** This (conversation, event_name) was already reported. */
  | 'already_reported';

export type ConversionResult =
  | { reported: true; eventId: string; fbtraceId: string | null }
  | { reported: false; skipped: ConversionSkipReason }
  | { reported: false; failed: true; error: string; fbtraceId: string | null };

export interface ReportConversionParams {
  accountId: string;
  conversationId: string;
  eventName: ConversionEventName;
  /** Money value. Omitted for non-monetary events such as Lead. */
  value?: number;
  currency?: string;
  /** The conversion's own time. Defaults to now. */
  eventTime?: Date;
}

/**
 * The deduplication key, and the ONLY place the "one conversion of each kind
 * per conversation" rule is expressed. Migration 065 enforces it as a UNIQUE
 * constraint on this exact string; the rule is deliberately not re-derived
 * anywhere else.
 *
 * Deterministic on purpose: a retry after a network timeout must produce the
 * same id, or a single admission gets counted twice and reported ROAS inflates.
 */
export function buildEventId(
  conversationId: string,
  eventName: ConversionEventName
): string {
  return `${conversationId}:${eventName}`;
}

/**
 * True when `eventTime` is inside Meta's 7-day window.
 *
 * Exported because the retry sweep must apply the identical test before
 * re-sending a 'failed' row - a row that failed for a transient reason on day 6
 * becomes permanently unreportable on day 8, and retrying it would fail the
 * whole batch it rides in.
 */
export function isWithinEventWindow(eventTime: Date, now: Date = new Date()) {
  const age = now.getTime() - eventTime.getTime();
  return age >= 0 && age <= MAX_EVENT_AGE_MS;
}

interface ConfigRow {
  waba_id: string | null;
  access_token: string;
  capi_dataset_id: string | null;
}

/** Meta's response envelope for POST /{dataset_id}/events. */
interface MetaEventsResponse {
  events_received?: number;
  fbtrace_id?: string;
  error?: { message?: string; code?: number; type?: string };
}

/**
 * Resolve the CAPI dataset for a WABA, minting one on first use and caching it
 * on the config row.
 *
 * Meta's onboarding flow creates the dataset once per WABA; the create call
 * returns the existing id when one already exists, so this is safe to retry.
 */
async function resolveDatasetId(
  db: SupabaseClient,
  config: ConfigRow,
  wabaId: string,
  token: string,
  phoneNumberId: string
): Promise<string | null> {
  if (config.capi_dataset_id) return config.capi_dataset_id;

  const res = await fetch(`${META_API_BASE}/${wabaId}/dataset`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => null)) as { id?: string } | null;
  if (!res.ok || !body?.id) return null;

  // Cache. A failure to persist is not fatal - the next call simply mints
  // again and gets the same id back - but it is worth knowing about, because
  // silently re-minting on every conversion is a rate limit waiting to happen.
  const { error } = await db
    .from('whatsapp_config')
    .update({ capi_dataset_id: body.id })
    .eq('phone_number_id', phoneNumberId);
  if (error) {
    console.error(
      '[capi] resolved dataset but failed to cache it',
      { phoneNumberId, wabaId },
      error
    );
  }
  return body.id;
}

/**
 * Report one conversion to Meta.
 *
 * Writes an audit row for EVERY outcome, including the skips. A conversion that
 * was never sent and left no trace is indistinguishable from a lead who never
 * converted, which is the single most expensive way this could fail.
 */
export async function reportConversion(
  db: SupabaseClient,
  p: ReportConversionParams
): Promise<ConversionResult> {
  const eventTime = p.eventTime ?? new Date();
  const eventId = buildEventId(p.conversationId, p.eventName);

  const { data: conv, error: convError } = await db
    .from('conversations')
    .select('ctwa_clid, phone_number_id')
    .eq('id', p.conversationId)
    .eq('account_id', p.accountId)
    .maybeSingle();

  // A read fault and a genuinely organic lead must not collapse into the same
  // outcome: most conversations legitimately have no ctwa_clid, so an outage
  // that returned nothing would be statistically invisible. Same reasoning as
  // resolveAlias() in lib/courses/queries.ts.
  if (convError) {
    console.error(
      '[capi] conversation lookup failed',
      p.conversationId,
      convError
    );
    return {
      reported: false,
      failed: true,
      error: 'conversation_lookup_failed',
      fbtraceId: null,
    };
  }

  const audit = async (
    status: 'sent' | 'failed' | 'skipped',
    fields: Record<string, unknown> = {}
  ) => {
    const { error } = await db.from('meta_conversion_events').upsert(
      {
        account_id: p.accountId,
        conversation_id: p.conversationId,
        event_name: p.eventName,
        event_id: eventId,
        event_time: eventTime.toISOString(),
        ctwa_clid: conv?.ctwa_clid ?? null,
        value: p.value ?? null,
        currency: p.value == null ? null : (p.currency ?? DEFAULT_CURRENCY),
        status,
        updated_at: new Date().toISOString(),
        ...fields,
      },
      { onConflict: 'event_id' }
    );
    if (error) {
      console.error(
        '[capi] failed to write audit row',
        { eventId, status },
        error
      );
    }
  };

  if (!conv?.ctwa_clid) {
    await audit('skipped', { reason: 'organic' });
    return { reported: false, skipped: 'organic' };
  }
  if (!conv.phone_number_id) {
    await audit('skipped', { reason: 'no_phone_number_id' });
    return { reported: false, skipped: 'no_phone_number_id' };
  }
  if (!isWithinEventWindow(eventTime)) {
    await audit('skipped', { reason: 'event_too_old' });
    return { reported: false, skipped: 'event_too_old' };
  }

  // Strict resolution: by the conversation's own number only. See the header
  // note on why the primary-config fallback is deliberately absent.
  const { data: cfg } = await db
    .from('whatsapp_config')
    .select('waba_id, access_token, capi_dataset_id')
    .eq('account_id', p.accountId)
    .eq('phone_number_id', conv.phone_number_id)
    .maybeSingle();

  const config = cfg as ConfigRow | null;
  if (!config?.waba_id) {
    await audit('skipped', { reason: 'no_waba_id' });
    return { reported: false, skipped: 'no_waba_id' };
  }

  let token: string;
  try {
    token = decrypt(config.access_token);
  } catch (e) {
    const error = e instanceof Error ? e.message : 'token_decrypt_failed';
    await audit('failed', { reason: error, waba_id: config.waba_id });
    return { reported: false, failed: true, error, fbtraceId: null };
  }

  const datasetId = await resolveDatasetId(
    db,
    config,
    config.waba_id,
    token,
    conv.phone_number_id
  );
  if (!datasetId) {
    // FAILED, not skipped, deliberately. Skips are permanent verdicts (organic,
    // too old); a missing dataset is a fixable configuration state - usually
    // the token lacking marketing permissions. The retry sweep only re-sends
    // 'pending' and 'failed', so marking this 'skipped' would have quietly
    // retired every queued conversion the first time the sweep ran before the
    // permission was granted, and granting it later would deliver nothing.
    await audit('failed', { reason: 'no_dataset', waba_id: config.waba_id });
    return {
      reported: false,
      failed: true,
      error: 'no_dataset',
      fbtraceId: null,
    };
  }

  const event: Record<string, unknown> = {
    event_name: p.eventName,
    event_time: Math.floor(eventTime.getTime() / 1000),
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    event_id: eventId,
    user_data: {
      whatsapp_business_account_id: config.waba_id,
      // Never hashed. See header note 1.
      ctwa_clid: conv.ctwa_clid,
    },
  };
  if (p.value != null) {
    event.custom_data = {
      currency: p.currency ?? DEFAULT_CURRENCY,
      value: p.value,
    };
  }

  let res: Response;
  let body: MetaEventsResponse | null = null;
  try {
    res = await fetch(`${META_API_BASE}/${datasetId}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ data: [event], partner_agent: 'kuanli' }),
    });
    body = (await res.json().catch(() => null)) as MetaEventsResponse | null;
  } catch (e) {
    const error = e instanceof Error ? e.message : 'network_error';
    await audit('failed', {
      reason: error,
      waba_id: config.waba_id,
      dataset_id: datasetId,
    });
    return { reported: false, failed: true, error, fbtraceId: null };
  }

  const fbtraceId = body?.fbtrace_id ?? null;
  if (!res.ok) {
    const error = body?.error?.message ?? `http_${res.status}`;
    await audit('failed', {
      reason: error,
      waba_id: config.waba_id,
      dataset_id: datasetId,
      fbtrace_id: fbtraceId,
    });
    return { reported: false, failed: true, error, fbtraceId };
  }

  await audit('sent', {
    waba_id: config.waba_id,
    dataset_id: datasetId,
    fbtrace_id: fbtraceId,
  });
  return { reported: true, eventId, fbtraceId };
}
