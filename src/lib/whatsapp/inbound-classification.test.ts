import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BACKFILL_LABEL,
  classifyInboundMessage,
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
    });
  });

  it('labels any other type Kuanli cannot read instead of storing a blank', () => {
    const result = classifyInboundMessage({ ...base, type: 'poll_creation' });
    expect(result?.contentText).toBe(
      'Unsupported message type (poll_creation). Check the WhatsApp Business app.'
    );
    expect(result?.forwardToBot).toBe(false);
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
