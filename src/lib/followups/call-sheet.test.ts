import { describe, expect, it } from 'vitest';

import { buildCallSheetHtml, callSheetRows } from './call-sheet';
import type { WorklistRow } from './types';

const NOW = new Date('2026-08-21T10:00:00+05:30');

function row(overrides: Partial<WorklistRow>): WorklistRow {
  return {
    contactId: 'c-1',
    entryId: 'e-1',
    conversationId: null,
    name: 'Asha',
    phone: '919800000001',
    rollNumber: null,
    university: 'LPU',
    stageName: 'Qualified',
    occurredAt: '2026-08-19T10:00:00+05:30',
    method: 'call',
    outcome: null,
    summary: 'Asked about fees',
    nextDueAt: '2026-08-21T09:00:00+05:30',
    nextMethod: 'call',
    loggedBy: 'u-1',
    loggedByName: 'Counsellor',
    ...overrides,
  };
}

describe('callSheetRows', () => {
  it('includes only overdue and today, overdue first', () => {
    const rows = callSheetRows(
      [
        row({ entryId: 'later', nextDueAt: '2026-08-25T09:00:00+05:30' }),
        row({ entryId: 'today', nextDueAt: '2026-08-21T17:00:00+05:30' }),
        row({ entryId: 'overdue', nextDueAt: '2026-08-19T09:00:00+05:30' }),
      ],
      NOW
    );
    expect(rows.map((r) => r.entryId)).toEqual(['overdue', 'today']);
  });
});

describe('buildCallSheetHtml', () => {
  it('escapes HTML in counsellor-entered text', () => {
    const html = buildCallSheetHtml(
      [row({ summary: '<script>alert(1)</script> & "quotes"' })],
      NOW
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp; &quot;quotes&quot;');
  });

  it('renders the empty state when nothing is due', () => {
    const html = buildCallSheetHtml(
      [row({ nextDueAt: '2026-08-30T09:00:00+05:30' })],
      NOW
    );
    expect(html).toContain('No calls due today.');
    expect(html).not.toContain('<table>');
  });

  it('counts due calls in the header line', () => {
    const html = buildCallSheetHtml(
      [
        row({ entryId: 'a', nextDueAt: '2026-08-19T09:00:00+05:30' }),
        row({ entryId: 'b', nextDueAt: '2026-08-21T17:00:00+05:30' }),
      ],
      NOW
    );
    expect(html).toContain('2 calls due');
  });
});
