import { describe, it, expect } from 'vitest';

import {
  MESSAGE_STATUS_LADDER,
  normalizeMessageStatus,
  statusesOverwritableBy,
} from './message-status';

/** Every value migration 001's CHECK constraint permits on messages.status. */
const ALLOWED_BY_CONSTRAINT = [
  'sending',
  'sent',
  'delivered',
  'read',
  'failed',
];

describe('normalizeMessageStatus', () => {
  it("folds Meta's voice-note 'played' into 'read'", () => {
    // The regression this whole module exists for: 'played' was written raw and
    // rejected with 23514 on every voice message.
    expect(normalizeMessageStatus('played')).toBe('read');
  });

  it('passes the constraint-legal statuses through unchanged', () => {
    for (const s of ['sent', 'delivered', 'read', 'failed'] as const) {
      expect(normalizeMessageStatus(s)).toBe(s);
    }
  });

  it('returns null for statuses the column cannot store', () => {
    expect(normalizeMessageStatus('deleted')).toBeNull();
    expect(normalizeMessageStatus('replied')).toBeNull();
    expect(normalizeMessageStatus('')).toBeNull();
  });

  it('never yields a value the CHECK constraint would reject', () => {
    const metaStatuses = [
      'sent',
      'delivered',
      'read',
      'played',
      'failed',
      'deleted',
      'warning',
    ];
    for (const s of metaStatuses) {
      const out = normalizeMessageStatus(s);
      if (out !== null) expect(ALLOWED_BY_CONSTRAINT).toContain(out);
    }
  });
});

describe('statusesOverwritableBy', () => {
  it('lets a status overwrite only what sits below it on the ladder', () => {
    expect(statusesOverwritableBy('read')).toEqual([
      'sending',
      'sent',
      'delivered',
    ]);
    expect(statusesOverwritableBy('delivered')).toEqual(['sending', 'sent']);
    expect(statusesOverwritableBy('sent')).toEqual(['sending']);
  });

  it('does not let a late webhook drag a message backwards', () => {
    // Meta does not guarantee ordering: 'delivered' arriving after 'read' must
    // not undo the read receipt.
    expect(statusesOverwritableBy('delivered')).not.toContain('read');
    expect(statusesOverwritableBy('sent')).not.toContain('delivered');
  });

  it('never lets a status overwrite itself, so a repeat is a no-op', () => {
    for (const s of MESSAGE_STATUS_LADDER) {
      expect(statusesOverwritableBy(s)).not.toContain(s);
    }
  });

  it("treats 'failed' as terminal and reachable only from in-flight", () => {
    expect(statusesOverwritableBy('failed')).toEqual(['sending', 'sent']);
    for (const s of MESSAGE_STATUS_LADDER) {
      expect(statusesOverwritableBy(s)).not.toContain('failed');
    }
  });

  it("yields an empty list for 'sending', so the update is skipped", () => {
    // Nothing precedes it; Meta never sends it either.
    expect(statusesOverwritableBy('sending')).toEqual([]);
  });

  it('a played voice note settles at read and stays there', () => {
    const next = normalizeMessageStatus('played')!;
    expect(statusesOverwritableBy(next)).toContain('delivered');
    // A second 'played' (or a plain 'read') afterwards changes nothing.
    expect(statusesOverwritableBy(next)).not.toContain('read');
  });
});
