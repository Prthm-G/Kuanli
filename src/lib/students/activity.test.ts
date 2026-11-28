import { describe, expect, it } from 'vitest';
import type { StudentTimelineItem } from './queries';
import { activityTitle, viaLabel } from './activity';

const base: StudentTimelineItem = {
  kind: 'follow_up',
  id: 'x',
  at: '2026-11-20T04:30:00Z',
  who: 'Agent',
  summary: 's',
  contactId: 'c1',
  phoneLast4: '0001',
  method: 'call',
  outcome: null,
  nextDueAt: null,
  nextMethod: null,
};

describe('activityTitle', () => {
  it('names each kind', () => {
    expect(activityTitle(base)).toBe('Call');
    expect(activityTitle({ ...base, method: null })).toBe('Follow-up');
    expect(activityTitle({ ...base, kind: 'bot_follow_up' })).toBe(
      'Automated follow-up'
    );
    expect(activityTitle({ ...base, kind: 'note' })).toBe('Note');
    expect(activityTitle({ ...base, kind: 'stage' })).toBe('Stage');
  });
});
describe('viaLabel', () => {
  it('is null for the opened record', () =>
    expect(viaLabel(base, 'c1')).toBeNull());
  it("shows the other record's last 4", () =>
    expect(viaLabel({ ...base, contactId: 'c2' }, 'c1')).toBe('via …0001'));
  it('says another record when it has no phone', () =>
    expect(viaLabel({ ...base, contactId: 'c2', phoneLast4: null }, 'c1')).toBe(
      'via another record'
    ));
});
