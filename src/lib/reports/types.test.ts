import { describe, expect, it } from 'vitest';
import { summarise, withoutCounsellorNumbers, type EodRow } from './types';

const row = (id: string, phoneNumberId: string | null): EodRow => ({
  conversationId: id,
  contactId: `c-${id}`,
  name: null,
  phone: null,
  university: null,
  mode: null,
  course: null,
  rollNumber: null,
  phoneNumberId,
  status: 'open',
  createdAt: '2026-11-09T00:00:00.000Z',
});

describe('withoutCounsellorNumbers', () => {
  const rows = [
    row('1', '100000000000001'),
    row('2', '100000000000002'),
    row('3', null),
  ];
  it('leaves out chats on counsellor numbers: they are not new leads', () => {
    expect(
      withoutCounsellorNumbers(rows, ['100000000000002']).map(
        (r) => r.conversationId
      )
    ).toEqual(['1', '3']);
    expect(
      summarise(withoutCounsellorNumbers(rows, ['100000000000002'])).total
    ).toBe(2);
  });
  it('no counsellor numbers: every row', () => {
    expect(withoutCounsellorNumbers(rows, [])).toBe(rows);
  });
});
