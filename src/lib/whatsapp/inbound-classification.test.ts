import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BACKFILL_LABEL,
  botForwardFor,
  classifyInboundMessage,
  greetCandidate,
  isPastFirstContact,
} from './inbound-classification';

const base = { id: 'wamid.X', from: '919999999999', timestamp: '1790000000' };

describe('classifyInboundMessage', () => {
  it('returns null for types the content parser already handles', () => {
    for (const type of [
      'text',
      'image',
      'interactive',
      'reaction',
      'sticker',
    ]) {
      expect(classifyInboundMessage({ ...base, type })).toBeNull();
    }
  });

  it('labels a 131060 unavailable message and keeps it from the bot', () => {
    const result = classifyInboundMessage({
      ...base,
      type: 'unsupported',
      unsupported: { type: 'unknown' },
      errors: [
        {
          code: 131060,
          title: 'This message is currently unavailable.',
          message: 'This message is currently unavailable.',
          error_data: { details: 'This message is currently unavailable.' },
        },
      ],
    });
    expect(result).toEqual({
      store: true,
      contentText:
        'Message unavailable (Meta 131060). They tried to reach us; follow up from the WhatsApp Business app.',
      interactiveReplyId: null,
      errorCode: 131060,
      errorDetails: 'This message is currently unavailable.',
      forwardToBot: false,
      automationText: '',
      greetWhenFirst: true,
    });
  });

  it('labels a 131051 unsupported type', () => {
    const result = classifyInboundMessage({
      ...base,
      type: 'unsupported',
      errors: [{ code: 131051, title: 'Message type unknown' }],
    });
    expect(result?.contentText).toBe(
      'Unsupported message type (Meta 131051). Check the WhatsApp Business app.'
    );
    expect(result?.errorCode).toBe(131051);
    expect(result?.errorDetails).toBe('Message type unknown');
    expect(result?.forwardToBot).toBe(false);
    expect(result?.greetWhenFirst).toBe(true);
  });

  it('still labels an unsupported message that carries no errors array', () => {
    const result = classifyInboundMessage({ ...base, type: 'unsupported' });
    expect(result?.store).toBe(true);
    expect(result?.contentText).toBe(
      'Unsupported message type. Check the WhatsApp Business app.'
    );
    expect(result?.errorCode).toBeNull();
    expect(result?.forwardToBot).toBe(false);
  });

  it('stores nothing for a revoke', () => {
    const result = classifyInboundMessage({
      ...base,
      type: 'revoke',
      revoke: { original_message_id: 'wamid.OLD' },
    });
    expect(result?.store).toBe(false);
    expect(result?.forwardToBot).toBe(false);
  });

  it('stores the new text of an edit, marked as edited, without the bot', () => {
    const result = classifyInboundMessage({
      ...base,
      type: 'edit',
      edit: {
        original_message_id: 'wamid.OLD',
        message: { type: 'text', text: { body: 'MBA online fees?' } },
      },
    });
    expect(result).toMatchObject({
      store: true,
      contentText: '(edited) MBA online fees?',
      forwardToBot: false,
      automationText: '',
    });
  });

  it('uses the caption of an edited media message', () => {
    const result = classifyInboundMessage({
      ...base,
      type: 'edit',
      edit: {
        original_message_id: 'wamid.OLD',
        message: { type: 'image', image: { caption: 'my marksheet' } },
      },
    });
    expect(result?.contentText).toBe('(edited) my marksheet');
  });

  it('falls back to a plain marker when an edit carries no text', () => {
    const result = classifyInboundMessage({ ...base, type: 'edit' });
    expect(result?.contentText).toBe('(edited message)');
  });

  it('treats a template quick-reply button as a real answer for the bot', () => {
    const result = classifyInboundMessage({
      ...base,
      type: 'button',
      button: { text: 'Yes, call me', payload: 'CALLBACK_YES' },
    });
    expect(result).toEqual({
      store: true,
      contentText: 'Yes, call me',
      interactiveReplyId: 'CALLBACK_YES',
      errorCode: null,
      errorDetails: null,
      forwardToBot: true,
      automationText: 'Yes, call me',
      greetWhenFirst: false,
    });
  });

  it('labels any other type Kuanli cannot read instead of storing a blank', () => {
    const result = classifyInboundMessage({ ...base, type: 'poll_creation' });
    expect(result?.contentText).toBe(
      'Unsupported message type (poll_creation). Check the WhatsApp Business app.'
    );
    expect(result?.forwardToBot).toBe(false);
  });

  it('only marks Meta unsupported messages as worth a first-contact greeting', () => {
    expect(
      classifyInboundMessage({ ...base, type: 'unsupported' })?.greetWhenFirst
    ).toBe(true);
    for (const type of ['revoke', 'edit', 'button', 'poll_creation']) {
      expect(classifyInboundMessage({ ...base, type })?.greetWhenFirst).toBe(
        false
      );
    }
  });
});

describe('botForwardFor', () => {
  const unsupported = classifyInboundMessage({ ...base, type: 'unsupported' });
  const edit = classifyInboundMessage({ ...base, type: 'edit' });
  const button = classifyInboundMessage({
    ...base,
    type: 'button',
    button: { text: 'Yes', payload: 'P' },
  });

  it('forwards a parsed message as itself', () => {
    expect(botForwardFor(null, false)).toEqual({ forward: true, greet: false });
    expect(botForwardFor(null, true)).toEqual({ forward: true, greet: false });
  });

  it('greets an unreadable message while nobody has replied yet', () => {
    expect(botForwardFor(unsupported, false)).toEqual({
      forward: true,
      greet: true,
    });
  });

  it('stays silent on an unreadable message once the chat has a reply', () => {
    expect(botForwardFor(unsupported, true)).toEqual({
      forward: false,
      greet: false,
    });
  });

  it('keeps edits away from the bot and buttons going to it', () => {
    expect(botForwardFor(edit, false).forward).toBe(false);
    expect(botForwardFor(button, true)).toEqual({
      forward: true,
      greet: false,
    });
  });

  // KB-FIXPASS-20261122: 6ddb4b12 (19 Nov) opened with an image and got no
  // reply, because n8n reads text, audio and taps only.
  it('greets a media first contact the bot cannot read', () => {
    for (const type of ['image', 'video', 'document', 'sticker', 'location']) {
      expect(botForwardFor(null, false, type)).toEqual({
        forward: true,
        greet: true,
      });
      expect(botForwardFor(null, true, type)).toEqual({
        forward: true,
        greet: false,
      });
    }
  });

  it('never greets text, audio, a tap or a reaction', () => {
    for (const type of ['text', 'audio', 'interactive', 'reaction']) {
      expect(botForwardFor(null, false, type)).toEqual({
        forward: true,
        greet: false,
      });
    }
  });
});

describe('greetCandidate', () => {
  it('follows the classifier for special messages', () => {
    const unsupported = classifyInboundMessage({ ...base, type: 'unsupported' });
    const edit = classifyInboundMessage({ ...base, type: 'edit' });
    expect(greetCandidate(unsupported, 'unsupported')).toBe(true);
    expect(greetCandidate(edit, 'edit')).toBe(false);
  });

  it('is true for media the bot cannot read and false for the rest', () => {
    expect(greetCandidate(null, 'image')).toBe(true);
    expect(greetCandidate(null, 'document')).toBe(true);
    expect(greetCandidate(null, 'text')).toBe(false);
    expect(greetCandidate(null, 'audio')).toBe(false);
  });
});

describe('isPastFirstContact', () => {
  const at = Date.parse('2026-11-22T10:00:00Z');
  const minutesBefore = (m: number) => new Date(at - m * 60000).toISOString();

  it('is first contact when nobody has written or replied before', () => {
    expect(
      isPastFirstContact({ hasReply: false, previousCustomerAt: null, messageAt: at })
    ).toBe(false);
  });

  it('is past first contact once the chat has any bot or agent message', () => {
    expect(
      isPastFirstContact({ hasReply: true, previousCustomerAt: null, messageAt: at })
    ).toBe(true);
  });

  it('treats an earlier customer message within 10 minutes as the same burst', () => {
    expect(
      isPastFirstContact({
        hasReply: false,
        previousCustomerAt: minutesBefore(2),
        messageAt: at,
      })
    ).toBe(true);
  });

  // 9f827adb and 6857796f (16-19 Nov): unreadable messages days apart, never
  // answered, because only the very first inbound was greeted.
  it('greets again when the earlier message was long ago and never answered', () => {
    expect(
      isPastFirstContact({
        hasReply: false,
        previousCustomerAt: minutesBefore(60 * 24 * 6),
        messageAt: at,
      })
    ).toBe(false);
  });

  it('counts an unparseable earlier time as the same burst (no double greeting)', () => {
    expect(
      isPastFirstContact({
        hasReply: false,
        previousCustomerAt: 'not a date',
        messageAt: at,
      })
    ).toBe(true);
  });
});

describe('BACKFILL_LABEL', () => {
  it('is the exact text migration 077 writes and its rollback matches', () => {
    for (const file of ['077_label_blank_inbound.sql', '077_rollback.sql']) {
      const sql = readFileSync(
        join(__dirname, '../../../supabase/migrations', file),
        'utf8'
      );
      expect(sql).toContain(`'${BACKFILL_LABEL}'`);
    }
  });
});
