import { describe, expect, it } from 'vitest';
import {
  HISTORY_DECLINED_CODE,
  HISTORY_MEDIA_PLACEHOLDER,
  historyScopeOf,
  historySender,
  planHistory,
  summarizeHistoryParts,
} from './history-sync';

// Shapes from Meta's history webhook reference (checked 2026-11-09), with
// made-up numbers and ids.
const BUSINESS = '15550001111';
const LEAD = '15550002222';
const OTHER = '15550003333';

const approved = {
  messaging_product: 'whatsapp',
  metadata: {
    display_phone_number: BUSINESS,
    phone_number_id: '100000000000009',
  },
  history: [
    {
      metadata: { phase: 0, chunk_order: 1, progress: 55 },
      threads: [
        {
          id: LEAD,
          context: { wa_id: LEAD, user_id: 'US.1' },
          messages: [
            {
              from: BUSINESS,
              id: 'wamid.T1',
              timestamp: '1739230955',
              type: 'text',
              text: { body: 'Here is the info' },
              history_context: { status: 'READ' },
            },
            {
              from: BUSINESS,
              id: 'wamid.T2',
              timestamp: '1739230970',
              type: 'media_placeholder',
              history_context: { status: 'PLAYED' },
            },
            {
              from: LEAD,
              from_user_id: 'US.1',
              id: 'wamid.T3',
              timestamp: '1739230980',
              type: 'text',
              text: { body: 'Thanks!' },
              history_context: { status: 'READ' },
            },
          ],
        },
        {
          id: OTHER,
          messages: [
            {
              from: BUSINESS,
              id: 'wamid.T4',
              timestamp: '1739230990',
              type: 'text',
              text: { body: 'Your order' },
              history_context: { status: 'delivered' },
            },
          ],
        },
      ],
    },
  ],
};

describe('planHistory: shared history', () => {
  const { parts, media } = planHistory(approved);

  it('one chunk with its phase, order and progress', () => {
    expect(media).toEqual([]);
    expect(parts).toHaveLength(1);
    const p = parts[0];
    expect(p.kind).toBe('chunk');
    if (p.kind !== 'chunk') return;
    expect([p.phase, p.chunkOrder, p.progress]).toEqual([0, 1, 55]);
    expect(p.skipped).toBe(0);
    expect(p.threads.map((t) => t.customerPhone)).toEqual([LEAD, OTHER]);
  });

  it('keeps the original time and the direction: the business is the agent', () => {
    const p = parts[0];
    if (p.kind !== 'chunk') throw new Error('chunk expected');
    const [a, b, c] = p.threads[0].messages;
    expect(a.senderType).toBe('agent');
    expect(a.createdAt).toBe(new Date(1739230955 * 1000).toISOString());
    expect(a.status).toBe('read');
    expect(c.senderType).toBe('customer');
    expect(c.status).toBe('delivered');
    expect(c.createdAt).toBe(new Date(1739230980 * 1000).toISOString());
    expect(b.placeholder).toBe(true);
    expect(b.status).toBe('read');
    expect(a.placeholder).toBe(false);
    expect(p.threads[1].messages[0].status).toBe('delivered');
  });

  it('summarizes for the log', () => {
    expect(summarizeHistoryParts(parts)).toEqual({
      declined: [],
      chunks: [
        {
          phase: 0,
          chunkOrder: 1,
          progress: 55,
          threads: 2,
          messages: 4,
          skipped: 0,
        },
      ],
    });
  });
});

describe('planHistory: declined', () => {
  const declined = {
    messaging_product: 'whatsapp',
    metadata: {
      display_phone_number: BUSINESS,
      phone_number_id: '100000000000009',
    },
    history: [
      {
        errors: [
          {
            code: 2593109,
            title:
              'History sync is turned off by the business from the WhatsApp Business App',
            message:
              'History sync is turned off by the business from the WhatsApp Business App',
            error_data: {
              details: 'History sharing is turned off by the business',
            },
          },
        ],
      },
    ],
  };

  it('is reported with Meta code 2593109 and stores nothing', () => {
    const { parts, media } = planHistory(declined);
    expect(media).toEqual([]);
    expect(parts).toEqual([
      {
        kind: 'error',
        code: HISTORY_DECLINED_CODE,
        details: 'History sharing is turned off by the business',
      },
    ]);
    expect(summarizeHistoryParts(parts).declined).toEqual([
      {
        code: 2593109,
        details: 'History sharing is turned off by the business',
      },
    ]);
  });
});

describe('planHistory: what it leaves out', () => {
  it('a thread without a phone number (username only) is skipped and counted', () => {
    const { parts } = planHistory({
      history: [
        {
          metadata: { phase: 1, chunk_order: 3, progress: 80 },
          threads: [
            {
              context: { user_id: 'US.9', username: 'someone' },
              messages: [
                {
                  from_user_id: 'US.9',
                  id: 'wamid.U1',
                  timestamp: '1739230955',
                  type: 'text',
                  text: { body: 'x' },
                },
                {
                  from: BUSINESS,
                  id: 'wamid.U2',
                  timestamp: '1739230956',
                  type: 'text',
                  text: { body: 'y' },
                },
              ],
            },
          ],
        },
      ],
    });
    const p = parts[0];
    if (p.kind !== 'chunk') throw new Error('chunk expected');
    expect(p.threads).toEqual([]);
    expect(p.skipped).toBe(2);
  });

  it('messages without an id or a readable time, and reactions, are skipped', () => {
    const { parts } = planHistory({
      history: [
        {
          threads: [
            {
              id: LEAD,
              messages: [
                {
                  from: LEAD,
                  timestamp: '1739230955',
                  type: 'text',
                  text: { body: 'no id' },
                },
                {
                  from: LEAD,
                  id: 'wamid.V2',
                  timestamp: 'soon',
                  type: 'text',
                  text: { body: 'bad time' },
                },
                {
                  from: LEAD,
                  id: 'wamid.V3',
                  timestamp: '1739230957',
                  type: 'reaction',
                  reaction: { emoji: 'x' },
                },
                {
                  from: LEAD,
                  id: 'wamid.V4',
                  timestamp: '1739230958',
                  type: 'text',
                  text: { body: 'ok' },
                },
              ],
            },
          ],
        },
      ],
    });
    const p = parts[0];
    if (p.kind !== 'chunk') throw new Error('chunk expected');
    expect(p.threads[0].messages.map((m) => m.message.id)).toEqual([
      'wamid.V4',
    ]);
    expect(p.skipped).toBe(3);
    expect([p.phase, p.chunkOrder, p.progress]).toEqual([null, null, null]);
  });

  it('an empty or odd payload plans nothing', () => {
    expect(planHistory({})).toEqual({ parts: [], media: [] });
    expect(planHistory({ history: [{}] })).toEqual({
      parts: [
        {
          kind: 'chunk',
          phase: null,
          chunkOrder: null,
          progress: null,
          threads: [],
          skipped: 0,
        },
      ],
      media: [],
    });
  });

  it('an error other than 2593109 is reported with its own code', () => {
    const { parts } = planHistory({
      history: [{ errors: [{ code: 131000, message: 'boom' }] }],
    });
    expect(parts).toEqual([{ kind: 'error', code: 131000, details: 'boom' }]);
    expect(summarizeHistoryParts(parts).declined).toEqual([]);
  });
});

describe('planHistory: media that follows a placeholder', () => {
  it('customer media comes as messages[], business media as message_echoes[]', () => {
    const { parts, media } = planHistory({
      metadata: {
        display_phone_number: BUSINESS,
        phone_number_id: '100000000000009',
      },
      messages: [
        {
          from: LEAD,
          from_user_id: 'US.1',
          id: 'wamid.M1',
          timestamp: '1738796547',
          type: 'image',
          image: {
            caption: 'marksheet',
            mime_type: 'image/jpeg',
            sha256: 'aa',
            id: '9000000000001',
          },
        },
      ],
      message_echoes: [
        {
          from: BUSINESS,
          to: LEAD,
          id: 'wamid.M2',
          timestamp: '1738796548',
          type: 'document',
          document: {
            mime_type: 'application/pdf',
            id: '9000000000002',
            filename: 'fees.pdf',
          },
        },
      ],
    });
    expect(parts).toEqual([]);
    expect(
      media.map((m) => [
        m.customerPhone,
        m.message.senderType,
        m.message.message.id,
        m.message.placeholder,
      ])
    ).toEqual([
      [LEAD, 'customer', 'wamid.M1', false],
      [LEAD, 'agent', 'wamid.M2', false],
    ]);
    expect(media[1].message.status).toBe('sent');
  });
});

describe('historySender', () => {
  it("from_user_id or the lead's own number means the lead wrote it", () => {
    expect(historySender({ from: LEAD }, LEAD)).toBe('customer');
    expect(historySender({ from: '+1 555 000 2222' }, LEAD)).toBe('customer');
    expect(historySender({ from_user_id: 'US.1' }, LEAD)).toBe('customer');
  });
  it("anything else is the business (the counsellor's app)", () => {
    expect(historySender({ from: BUSINESS }, LEAD)).toBe('agent');
    expect(historySender({}, LEAD)).toBe('agent');
  });
});

it('the placeholder text is fixed, so the media that follows can find its row', () => {
  expect(HISTORY_MEDIA_PLACEHOLDER).toBe('[Media from chat history]');
});

describe('historyScopeOf', () => {
  it("'known_contacts' only when set so; anything else (the default) is every thread", () => {
    expect(historyScopeOf('known_contacts')).toBe('known_contacts');
    expect(historyScopeOf('all')).toBe('all');
    expect(historyScopeOf(undefined)).toBe('all');
  });
});
