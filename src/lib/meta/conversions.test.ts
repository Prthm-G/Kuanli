import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildEventId,
  isWithinEventWindow,
  reportConversion,
  MAX_EVENT_AGE_MS,
} from './conversions';

// The real decrypt needs ENCRYPTION_KEY and real ciphertext. What matters to
// these tests is that the DECRYPTED token reaches Meta and the encrypted one
// never does, so the fake makes the difference observable.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => {
    if (v === 'BAD') throw new Error('unexpected GCM IV length 7');
    return v.replace(/^enc:/, '');
  },
}));

/**
 * In-memory Supabase stand-in.
 *
 * Filtering is real - a test where the module forgets an `.eq('account_id')`
 * fails here rather than passing against a mock that returns whatever it was
 * handed. Writes are captured so the audit trail can be asserted on, because
 * "an unsent conversion leaves a row" is the actual requirement, not a detail.
 */
function fakeSupabase(tables: Record<string, Record<string, unknown>[]>) {
  const writes: { table: string; op: string; row: Record<string, unknown> }[] =
    [];
  const db = {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const builder: Record<string, unknown> = {
        select: () => builder,
        update: (row: Record<string, unknown>) => {
          writes.push({ table, op: 'update', row });
          return builder;
        },
        upsert: (row: Record<string, unknown>) => {
          writes.push({ table, op: 'upsert', row });
          return Promise.resolve({ error: null });
        },
        eq: (col: string, val: unknown) => {
          rows = rows.filter((r) => r[col] === val);
          return builder;
        },
        maybeSingle: () =>
          Promise.resolve({ data: rows[0] ?? null, error: null }),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { db, writes };
}

const ACCOUNT = 'acct-1';
const CONV = 'conv-1';
const PHONE_LIVE = '110485318348695';
const WABA_LIVE = '106777392057661';

const CONV_FROM_AD = {
  id: CONV,
  account_id: ACCOUNT,
  ctwa_clid: 'ARAkLkA8rmlFeiCktEJQ',
  phone_number_id: PHONE_LIVE,
};

const CONFIG_LIVE = {
  account_id: ACCOUNT,
  phone_number_id: PHONE_LIVE,
  waba_id: WABA_LIVE,
  access_token: 'enc:TOKEN_LIVE',
  capi_dataset_id: 'ds-live',
};

/** The is_primary row, on a DIFFERENT WABA, which must never be used here. */
const CONFIG_PRIMARY = {
  account_id: ACCOUNT,
  phone_number_id: '1197620893430601',
  waba_id: '2170658457111515',
  access_token: 'enc:TOKEN_PRIMARY',
  capi_dataset_id: 'ds-primary',
};

function okFetch(body: Record<string, unknown> = { events_received: 1 }) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  });
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = okFetch();
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function lastPost() {
  const call = fetchSpy.mock.calls.at(-1);
  return { url: call?.[0] as string, init: call?.[1] as RequestInit };
}
function postedEvent() {
  return JSON.parse(String(lastPost().init.body)).data[0];
}
function auditRows(writes: { table: string; row: Record<string, unknown> }[]) {
  return writes.filter((w) => w.table === 'meta_conversion_events');
}

describe('buildEventId', () => {
  it('is deterministic so a retry cannot double-count an admission', () => {
    expect(buildEventId(CONV, 'Purchase')).toBe(buildEventId(CONV, 'Purchase'));
  });

  it('separates event kinds on the same conversation', () => {
    expect(buildEventId(CONV, 'LeadSubmitted')).not.toBe(
      buildEventId(CONV, 'Purchase')
    );
  });
});

describe('isWithinEventWindow', () => {
  const now = new Date('2026-08-21T12:00:00Z');

  it('accepts an event from just inside 7 days', () => {
    const t = new Date(now.getTime() - MAX_EVENT_AGE_MS + 1000);
    expect(isWithinEventWindow(t, now)).toBe(true);
  });

  it('rejects an event from just outside 7 days', () => {
    const t = new Date(now.getTime() - MAX_EVENT_AGE_MS - 1000);
    expect(isWithinEventWindow(t, now)).toBe(false);
  });

  it('rejects a future event time', () => {
    expect(isWithinEventWindow(new Date(now.getTime() + 60_000), now)).toBe(
      false
    );
  });
});

describe('reportConversion - payload contract', () => {
  it('sends the business-messaging shape with an UNHASHED ctwa_clid', async () => {
    const { db } = fakeSupabase({
      conversations: [CONV_FROM_AD],
      whatsapp_config: [CONFIG_LIVE, CONFIG_PRIMARY],
    });

    const result = await reportConversion(db, {
      accountId: ACCOUNT,
      conversationId: CONV,
      eventName: 'LeadSubmitted',
    });

    expect(result).toMatchObject({ reported: true });
    const event = postedEvent();
    expect(event.action_source).toBe('business_messaging');
    expect(event.messaging_channel).toBe('whatsapp');
    // The whole feature turns on this being the raw click id. A hashed value
    // is accepted by Meta and silently matches nothing.
    expect(event.user_data.ctwa_clid).toBe(CONV_FROM_AD.ctwa_clid);
    expect(event.user_data.whatsapp_business_account_id).toBe(WABA_LIVE);
    expect(event.event_id).toBe(buildEventId(CONV, 'LeadSubmitted'));
    expect(typeof event.event_time).toBe('number');
  });

  it('omits custom_data entirely for a valueless Lead', async () => {
    const { db } = fakeSupabase({
      conversations: [CONV_FROM_AD],
      whatsapp_config: [CONFIG_LIVE],
    });
    await reportConversion(db, {
      accountId: ACCOUNT,
      conversationId: CONV,
      eventName: 'LeadSubmitted',
    });
    expect(postedEvent().custom_data).toBeUndefined();
  });

  it('reports Purchase value in INR by default', async () => {
    const { db } = fakeSupabase({
      conversations: [CONV_FROM_AD],
      whatsapp_config: [CONFIG_LIVE],
    });
    await reportConversion(db, {
      accountId: ACCOUNT,
      conversationId: CONV,
      eventName: 'Purchase',
      value: 51000,
    });
    expect(postedEvent().custom_data).toEqual({
      currency: 'INR',
      value: 51000,
    });
  });

  it('posts to the dataset events edge with the DECRYPTED token', async () => {
    const { db } = fakeSupabase({
      conversations: [CONV_FROM_AD],
      whatsapp_config: [CONFIG_LIVE],
    });
    await reportConversion(db, {
      accountId: ACCOUNT,
      conversationId: CONV,
      eventName: 'LeadSubmitted',
    });
    const { url, init } = lastPost();
    expect(url).toContain('/ds-live/events');
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth).toBe('Bearer TOKEN_LIVE');
    expect(auth).not.toContain('enc:');
  });
});

describe('reportConversion - WABA resolution', () => {
  // The regression this project keeps producing: a rule applied in one place
  // and eyeballed in another. getConfigForConversation falls back to the
  // primary config; this path must NOT, because the primary row is on a
  // different WABA than the one receiving live traffic.
  it('uses the conversation own number, never the is_primary row', async () => {
    const { db } = fakeSupabase({
      conversations: [CONV_FROM_AD],
      whatsapp_config: [CONFIG_PRIMARY, CONFIG_LIVE],
    });
    await reportConversion(db, {
      accountId: ACCOUNT,
      conversationId: CONV,
      eventName: 'LeadSubmitted',
    });
    expect(postedEvent().user_data.whatsapp_business_account_id).toBe(
      WABA_LIVE
    );
    expect(lastPost().url).toContain('/ds-live/events');
  });

  it('refuses rather than falling back when the number has no config', async () => {
    const { db, writes } = fakeSupabase({
      conversations: [{ ...CONV_FROM_AD, phone_number_id: 'unknown-number' }],
      whatsapp_config: [CONFIG_PRIMARY],
    });
    const result = await reportConversion(db, {
      accountId: ACCOUNT,
      conversationId: CONV,
      eventName: 'LeadSubmitted',
    });
    expect(result).toEqual({ reported: false, skipped: 'no_waba_id' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(auditRows(writes)[0].row).toMatchObject({
      status: 'skipped',
      reason: 'no_waba_id',
    });
  });

  it('cannot read another account config', async () => {
    const { db } = fakeSupabase({
      conversations: [CONV_FROM_AD],
      whatsapp_config: [{ ...CONFIG_LIVE, account_id: 'other-acct' }],
    });
    const result = await reportConversion(db, {
      accountId: ACCOUNT,
      conversationId: CONV,
      eventName: 'LeadSubmitted',
    });
    expect(result).toEqual({ reported: false, skipped: 'no_waba_id' });
  });
});

describe('reportConversion - skips are recorded, never silent', () => {
  it('skips an organic conversation and leaves an audit row', async () => {
    const { db, writes } = fakeSupabase({
      conversations: [{ ...CONV_FROM_AD, ctwa_clid: null }],
      whatsapp_config: [CONFIG_LIVE],
    });
    const result = await reportConversion(db, {
      accountId: ACCOUNT,
      conversationId: CONV,
      eventName: 'LeadSubmitted',
    });
    expect(result).toEqual({ reported: false, skipped: 'organic' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(auditRows(writes)[0].row).toMatchObject({
      status: 'skipped',
      reason: 'organic',
    });
  });

  it('skips an event outside the 7-day window instead of poisoning the batch', async () => {
    const { db, writes } = fakeSupabase({
      conversations: [CONV_FROM_AD],
      whatsapp_config: [CONFIG_LIVE],
    });
    const result = await reportConversion(db, {
      accountId: ACCOUNT,
      conversationId: CONV,
      eventName: 'Purchase',
      value: 51000,
      eventTime: new Date(Date.now() - MAX_EVENT_AGE_MS - 60_000),
    });
    expect(result).toEqual({ reported: false, skipped: 'event_too_old' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(auditRows(writes)[0].row).toMatchObject({
      status: 'skipped',
      reason: 'event_too_old',
    });
  });

  it('records a missing phone_number_id rather than guessing a WABA', async () => {
    const { db, writes } = fakeSupabase({
      conversations: [{ ...CONV_FROM_AD, phone_number_id: null }],
      whatsapp_config: [CONFIG_LIVE],
    });
    const result = await reportConversion(db, {
      accountId: ACCOUNT,
      conversationId: CONV,
      eventName: 'LeadSubmitted',
    });
    expect(result).toEqual({ reported: false, skipped: 'no_phone_number_id' });
    expect(auditRows(writes)[0].row).toMatchObject({
      reason: 'no_phone_number_id',
    });
  });
});

describe('reportConversion - failures are recorded and retryable', () => {
  it('captures Meta error message and fbtrace_id', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: { message: 'Invalid ctwa_clid' },
        fbtrace_id: 'ABC123',
      }),
    });
    const { db, writes } = fakeSupabase({
      conversations: [CONV_FROM_AD],
      whatsapp_config: [CONFIG_LIVE],
    });
    const result = await reportConversion(db, {
      accountId: ACCOUNT,
      conversationId: CONV,
      eventName: 'LeadSubmitted',
    });
    expect(result).toMatchObject({
      failed: true,
      error: 'Invalid ctwa_clid',
      fbtraceId: 'ABC123',
    });
    expect(auditRows(writes)[0].row).toMatchObject({
      status: 'failed',
      reason: 'Invalid ctwa_clid',
      fbtrace_id: 'ABC123',
    });
  });

  it('records a network throw as failed, not as a skip', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNRESET'));
    const { db, writes } = fakeSupabase({
      conversations: [CONV_FROM_AD],
      whatsapp_config: [CONFIG_LIVE],
    });
    const result = await reportConversion(db, {
      accountId: ACCOUNT,
      conversationId: CONV,
      eventName: 'LeadSubmitted',
    });
    expect(result).toMatchObject({ failed: true, error: 'ECONNRESET' });
    expect(auditRows(writes)[0].row).toMatchObject({ status: 'failed' });
  });

  it('records a token that will not decrypt without calling Meta', async () => {
    const { db, writes } = fakeSupabase({
      conversations: [CONV_FROM_AD],
      whatsapp_config: [{ ...CONFIG_LIVE, access_token: 'BAD' }],
    });
    const result = await reportConversion(db, {
      accountId: ACCOUNT,
      conversationId: CONV,
      eventName: 'LeadSubmitted',
    });
    expect(result).toMatchObject({ failed: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(auditRows(writes)[0].row).toMatchObject({ status: 'failed' });
  });
});

describe('reportConversion - dataset resolution', () => {
  it('uses the cached dataset without minting a new one', async () => {
    const { db } = fakeSupabase({
      conversations: [CONV_FROM_AD],
      whatsapp_config: [CONFIG_LIVE],
    });
    await reportConversion(db, {
      accountId: ACCOUNT,
      conversationId: CONV,
      eventName: 'LeadSubmitted',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(lastPost().url).toContain('/events');
  });

  it('mints and caches a dataset on first use', async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'ds-new' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ events_received: 1 }),
      });
    const { db, writes } = fakeSupabase({
      conversations: [CONV_FROM_AD],
      whatsapp_config: [{ ...CONFIG_LIVE, capi_dataset_id: null }],
    });
    const result = await reportConversion(db, {
      accountId: ACCOUNT,
      conversationId: CONV,
      eventName: 'LeadSubmitted',
    });
    expect(result).toMatchObject({ reported: true });
    expect(fetchSpy.mock.calls[0][0]).toContain(`/${WABA_LIVE}/dataset`);
    expect(lastPost().url).toContain('/ds-new/events');
    expect(
      writes.some(
        (w) =>
          w.table === 'whatsapp_config' && w.row.capi_dataset_id === 'ds-new'
      )
    ).toBe(true);
  });

  it('records a missing dataset as FAILED so the sweep retries it', async () => {
    // The distinction is load-bearing: the sweep re-sends pending+failed only.
    // A permanent 'skipped' here would retire every queued conversion the
    // first time the sweep ran before the token had marketing permissions.
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: 'no permission' } }),
    });
    const { db, writes } = fakeSupabase({
      conversations: [CONV_FROM_AD],
      whatsapp_config: [{ ...CONFIG_LIVE, capi_dataset_id: null }],
    });
    const result = await reportConversion(db, {
      accountId: ACCOUNT,
      conversationId: CONV,
      eventName: 'LeadSubmitted',
    });
    expect(result).toMatchObject({ failed: true, error: 'no_dataset' });
    expect(auditRows(writes)[0].row).toMatchObject({
      status: 'failed',
      reason: 'no_dataset',
    });
  });
});
