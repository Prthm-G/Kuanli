import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The webhook route end to end for the `history` field (migration 094), with
// the service-role client replaced by a recorder. Made-up numbers and ids.

interface Op {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' | 'rpc';
  filters: [string, unknown][];
  payload?: unknown;
}
type Result = { data: unknown; error: unknown };

const h = vi.hoisted(() => ({
  ops: [] as Op[],
  handler: (() => ({ data: null, error: null })) as (op: Op) => Result,
}));

vi.mock('@supabase/supabase-js', () => {
  const builder = (table: string) => {
    const op: Op = { table, op: 'select', filters: [] };
    const b: Record<string, unknown> = {};
    const chain =
      (fn?: (...a: unknown[]) => void) =>
      (...a: unknown[]) => {
        fn?.(...a);
        return b;
      };
    Object.assign(b, {
      select: chain(),
      insert: chain((p) => Object.assign(op, { op: 'insert', payload: p })),
      update: chain((p) => Object.assign(op, { op: 'update', payload: p })),
      upsert: chain((p) => Object.assign(op, { op: 'upsert', payload: p })),
      delete: chain(() => Object.assign(op, { op: 'delete' })),
      eq: chain((c, v) => op.filters.push([String(c), v])),
      in: chain((c, v) => op.filters.push([String(c), v])),
      is: chain((c, v) => op.filters.push([String(c), v])),
      like: chain((c, v) => op.filters.push([String(c), v])),
      or: chain(),
      order: chain(),
      limit: chain(),
      single: chain(),
      maybeSingle: chain(),
      then: (res: (r: Result) => unknown, rej: (e: unknown) => unknown) => {
        h.ops.push(op);
        return Promise.resolve()
          .then(() => h.handler(op))
          .then(res, rej);
      },
    });
    return b;
  };
  const client = {
    from: (t: string) => builder(t),
    rpc: async (name: string, args: unknown) => {
      const op: Op = {
        table: `rpc:${name}`,
        op: 'rpc',
        filters: [],
        payload: args,
      };
      h.ops.push(op);
      return h.handler(op);
    },
    storage: { from: () => ({}) },
  };
  return { createClient: () => client };
});
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'token',
  encrypt: (x: string) => x,
  isLegacyFormat: () => false,
}));
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: vi.fn(async () => {}),
}));
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: vi.fn(async () => ({ consumed: false })),
}));

import { POST } from './route';

const PN_COUNSELLOR = '100000000000002';
const BUSINESS = '15550001111';
const LEAD_A = '15550002222';
const LEAD_B = '15550003333';

const historyBody = (phoneNumberId: string) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '200000000000001',
      changes: [
        {
          field: 'history',
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: BUSINESS,
              phone_number_id: phoneNumberId,
            },
            history: [
              {
                metadata: { phase: 0, chunk_order: 1, progress: 100 },
                threads: [
                  {
                    id: LEAD_A,
                    messages: [
                      {
                        from: LEAD_A,
                        from_user_id: 'US.1',
                        id: 'wamid.HA1',
                        timestamp: '1739230955',
                        type: 'text',
                        text: { body: 'hello' },
                      },
                      {
                        from: BUSINESS,
                        id: 'wamid.HA2',
                        timestamp: '1739230970',
                        type: 'text',
                        text: { body: 'hi, how can I help' },
                        history_context: { status: 'read' },
                      },
                    ],
                  },
                  {
                    id: LEAD_B,
                    messages: [
                      {
                        from: LEAD_B,
                        id: 'wamid.HB1',
                        timestamp: '1739230990',
                        type: 'text',
                        text: { body: 'fees?' },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
    },
  ],
});

function post(body: unknown) {
  const raw = JSON.stringify(body);
  const sig = createHmac('sha256', 'test-meta-app-secret')
    .update(raw)
    .digest('hex');
  return POST(
    new Request('http://localhost/api/whatsapp/webhook', {
      method: 'POST',
      headers: { 'x-hub-signature-256': `sha256=${sig}` },
      body: raw,
    })
  );
}

// The route answers Meta first and processes after; wait for the inbox row to be settled.
async function settled(): Promise<Op> {
  for (let i = 0; i < 200; i++) {
    const s = h.ops.find(
      (o) => o.table === 'webhook_inbox' && o.op === 'update'
    );
    if (s) return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('the inbox row was never settled');
}

const writes = (table: string) =>
  h.ops.filter(
    (o) => o.table === table && (o.op === 'insert' || o.op === 'update')
  );
const inserted = () =>
  writes('messages').flatMap((o) =>
    o.op === 'insert' ? [o.payload].flat() : []
  ) as Record<string, unknown>[];

function world(o: {
  counsellor: 'yes' | 'no' | 'error';
  failContactFor?: string;
  scope?: 'all' | 'known_contacts';
  known?: string[];
}): (op: Op) => Result {
  let contacts = 0;
  return (op) => {
    if (op.table === 'webhook_inbox' && op.op === 'insert')
      return { data: { id: 7 }, error: null };
    if (op.table === 'rpc:claim_webhook_inbox')
      return { data: [], error: null };
    if (op.table === 'whatsapp_config') {
      return {
        data: [
          {
            id: 'cfg',
            account_id: 'acc',
            user_id: 'usr',
            access_token: 'x',
            display_phone_number: BUSINESS,
            history_scope: o.scope ?? 'all',
          },
        ],
        error: null,
      };
    }
    if (op.table === 'counsellor_number_history') {
      if (o.counsellor === 'error')
        return { data: null, error: { message: 'connection reset' } };
      return {
        data: o.counsellor === 'yes' ? [{ phone_number_id: 'pn' }] : [],
        error: null,
      };
    }
    // findExistingContact: a suffix match on the phone.
    if (op.table === 'contacts' && op.op === 'select') {
      const like = op.filters.find(([c]) => c === 'phone')?.[1];
      const hit = (o.known ?? []).find((k) => `%${k.slice(-8)}` === like);
      return {
        data: hit ? [{ id: `known-${hit}`, phone: hit, name: hit }] : [],
        error: null,
      };
    }
    // A contact first seen on a counsellor number comes from the RPC (no LD
    // number); any other from a plain insert.
    if (
      op.table === 'rpc:create_counsellor_number_contact' ||
      (op.table === 'contacts' && op.op === 'insert')
    ) {
      const pl = op.payload as { phone?: string; p_phone?: string };
      const phone = pl.p_phone ?? pl.phone ?? '';
      if (o.failContactFor && phone.endsWith(o.failContactFor.slice(-4)))
        // Postgres error details can quote the number; the log must not.
        return {
          data: null,
          error: { message: `insert failed for ${phone}`, code: 'XX000' },
        };
      contacts += 1;
      const row = { id: `ct${contacts}`, phone };
      return { data: op.op === 'rpc' ? [row] : row, error: null };
    }
    if (op.table === 'conversations' && op.op === 'select')
      return { data: null, error: null };
    if (op.table === 'conversations' && op.op === 'insert')
      return { data: { id: `cv-${contacts}` }, error: null };
    if (op.table === 'messages' && op.op === 'select')
      return { data: [], error: null };
    return { data: null, error: null };
  };
}

describe('webhook: history', () => {
  beforeEach(() => {
    h.ops.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('on a counsellor number: stores each message with its original time and sender, then settles the inbox row', async () => {
    h.handler = world({ counsellor: 'yes' });
    expect((await post(historyBody(PN_COUNSELLOR))).status).toBe(200);
    const s = await settled();
    expect(s.payload).toHaveProperty('processed_at');
    const rows = inserted();
    expect(
      rows.map((r) => [r.message_id, r.sender_type, r.created_at])
    ).toEqual([
      ['wamid.HA1', 'customer', new Date(1739230955 * 1000).toISOString()],
      ['wamid.HA2', 'agent', new Date(1739230970 * 1000).toISOString()],
      ['wamid.HB1', 'customer', new Date(1739230990 * 1000).toISOString()],
    ]);
    expect(rows[1].status).toBe('read');
    // History never reaches n8n and never marks a lead reached.
    expect(h.ops.some((o) => o.table === 'rpc:mark_counsellor_reached')).toBe(
      false
    );
  });

  it('on a number that is not a counsellor number: stores nothing, logs, settles', async () => {
    h.handler = world({ counsellor: 'no' });
    await post(historyBody('100000000000001'));
    const s = await settled();
    expect(s.payload).toHaveProperty('processed_at');
    expect(writes('messages')).toEqual([]);
    expect(writes('contacts')).toEqual([]);
    expect(writes('conversations')).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('not a counsellor number'),
      '100000000000001',
      3
    );
  });

  it('fails closed when the counsellor lookup fails: nothing stored, the row is left for replay', async () => {
    h.handler = world({ counsellor: 'error' });
    await post(historyBody(PN_COUNSELLOR));
    const s = await settled();
    expect(s.payload).toHaveProperty('last_error');
    expect(String((s.payload as { last_error: string }).last_error)).toContain(
      'kuanli-number-policy-db-v2'
    );
    expect(writes('messages')).toEqual([]);
    expect(writes('contacts')).toEqual([]);
  });

  it('one bad thread does not fail the chunk: the other thread is stored and the row is settled', async () => {
    h.handler = world({ counsellor: 'yes', failContactFor: LEAD_A });
    await post(historyBody(PN_COUNSELLOR));
    const s = await settled();
    expect(s.payload).toHaveProperty('processed_at');
    expect(inserted().map((r) => r.message_id)).toEqual(['wamid.HB1']);
    // The failed contact's number is masked in the log.
    const logged = (
      console.error as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls
      .flat()
      .map(String)
      .join(' ');
    expect(logged).not.toContain(LEAD_A);
    expect(logged).toContain('***2222');
  });

  it('new contacts come from create_counsellor_number_contact, never a plain insert (no LD number)', async () => {
    h.handler = world({ counsellor: 'yes' });
    await post(historyBody(PN_COUNSELLOR));
    await settled();
    expect(
      h.ops
        .filter((o) => o.table === 'rpc:create_counsellor_number_contact')
        .map((o) => (o.payload as { p_phone: string }).p_phone)
    ).toEqual([LEAD_A, LEAD_B]);
    expect(writes('contacts')).toEqual([]);
  });

  it('scope known_contacts: only threads with someone already in Contacts are stored', async () => {
    h.handler = world({
      counsellor: 'yes',
      scope: 'known_contacts',
      known: [LEAD_B],
    });
    await post(historyBody(PN_COUNSELLOR));
    const s = await settled();
    expect(s.payload).toHaveProperty('processed_at');
    expect(inserted().map((r) => r.message_id)).toEqual(['wamid.HB1']);
    expect(
      h.ops.some((o) => o.table === 'rpc:create_counsellor_number_contact')
    ).toBe(false);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('not a known contact %d'),
      PN_COUNSELLOR,
      'known_contacts',
      expect.any(String),
      0,
      1,
      0,
      2,
      0
    );
  });

  it('a chunk where nothing could be stored is left for replay', async () => {
    h.handler = (op) =>
      op.table === 'rpc:create_counsellor_number_contact'
        ? { data: null, error: { message: 'down', code: 'XX000' } }
        : world({ counsellor: 'yes' })(op);
    await post(historyBody(PN_COUNSELLOR));
    const s = await settled();
    expect(String((s.payload as { last_error?: string }).last_error)).toContain(
      'none of 3 message(s) stored'
    );
  });

  it('a long chat is looked up in batches small enough for the gateway URL limit, and stored whole', async () => {
    // Real wamids are ~76-90 chars; 200 of them in one .in() made "URI too long".
    const body = historyBody(PN_COUNSELLOR);
    const history = body.entry[0].changes[0].value.history[0];
    history.threads = [
      {
        id: LEAD_A,
        messages: Array.from({ length: 120 }, (_, i) => ({
          from: LEAD_A,
          id: `wamid.LONG${i}`,
          timestamp: String(1739230955 + i),
          type: 'text',
          text: { body: `m${i}` },
        })),
      },
    ];
    h.handler = world({ counsellor: 'yes' });
    await post(body);
    await settled();
    const lookups = h.ops
      .filter((o) => o.table === 'messages' && o.op === 'select')
      .map((o) => o.filters.find(([c]) => c === 'message_id')?.[1])
      .filter(Array.isArray) as string[][];
    expect(lookups.flat()).toHaveLength(120);
    expect(Math.max(...lookups.map((l) => l.length))).toBeLessThanOrEqual(40);
    expect(inserted()).toHaveLength(120);
  });
});

const inboundBody = (phoneNumberId: string) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '200000000000001',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: BUSINESS,
              phone_number_id: phoneNumberId,
            },
            contacts: [{ profile: { name: 'Someone' }, wa_id: LEAD_A }],
            messages: [
              {
                from: LEAD_A,
                id: 'wamid.LIVE1',
                timestamp: '1739230955',
                type: 'text',
                text: { body: 'hi' },
              },
            ],
          },
        },
      ],
    },
  ],
});

describe('webhook: a new person on a live message', () => {
  beforeEach(() => {
    h.ops.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('on a counsellor number the contact comes from create_counsellor_number_contact (no LD number) and arrival is marked', async () => {
    h.handler = world({ counsellor: 'yes' });
    await post(inboundBody(PN_COUNSELLOR));
    await settled();
    expect(
      h.ops.filter((o) => o.table === 'rpc:create_counsellor_number_contact')
    ).toHaveLength(1);
    expect(writes('contacts')).toEqual([]);
    expect(inserted().map((r) => r.message_id)).toEqual(['wamid.LIVE1']);
    expect(h.ops.some((o) => o.table === 'rpc:mark_counsellor_reached')).toBe(
      true
    );
  });

  it('when the chat cannot be created after the contact, it throws so the inbox row replays (no chatless contact left behind silently)', async () => {
    h.handler = (op) =>
      op.table === 'conversations' && op.op === 'insert'
        ? { data: null, error: { message: 'down', code: 'XX000' } }
        : world({ counsellor: 'yes' })(op);
    await post(inboundBody(PN_COUNSELLOR));
    const s = await settled();
    expect(String((s.payload as { last_error?: string }).last_error)).toContain(
      'conversation not found or created'
    );
    expect(inserted()).toEqual([]);
  });

  it('on the bot number it is a plain insert, as before', async () => {
    h.handler = world({ counsellor: 'no' });
    await post(inboundBody('100000000000001'));
    await settled();
    expect(
      h.ops.some((o) => o.table === 'rpc:create_counsellor_number_contact')
    ).toBe(false);
    expect(writes('contacts')).toHaveLength(1);
    expect(h.ops.some((o) => o.table === 'rpc:mark_counsellor_reached')).toBe(
      false
    );
  });
});
