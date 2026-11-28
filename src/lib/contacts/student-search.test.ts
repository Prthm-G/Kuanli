import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { matchLabel, searchStudents } from './student-search';

function fakeDb(result: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { db: { rpc } as unknown as SupabaseClient, rpc };
}

describe('searchStudents', () => {
  it('calls the RPC with the trimmed term', async () => {
    const { db, rpc } = fakeDb({ data: [], error: null });
    await searchStudents(db, 'acc-1', '  ab12  ');
    expect(rpc).toHaveBeenCalledWith('search_students', {
      p_account: 'acc-1',
      p_q: 'ab12',
    });
  });

  it('returns [] under 2 chars without calling', async () => {
    const { db, rpc } = fakeDb({ data: [], error: null });
    expect(await searchStudents(db, 'acc-1', ' a ')).toEqual([]);
    expect(await searchStudents(db, 'acc-1', '')).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('maps rows to hits', async () => {
    const { db } = fakeDb({
      data: [
        {
          contact_id: 'c1',
          name: 'N',
          phone: '911234567890',
          university: 'U',
          provisional_app_id: 'P1',
          university_app_number: 'A1',
          registration_number: 'R1',
          matched: 'provisional_id',
        },
      ],
      error: null,
    });
    expect(await searchStudents(db, 'acc-1', 'p1')).toEqual([
      {
        contactId: 'c1',
        name: 'N',
        phone: '911234567890',
        university: 'U',
        provisionalAppId: 'P1',
        universityAppNumber: 'A1',
        registrationNumber: 'R1',
        matched: 'provisional_id',
      },
    ]);
  });

  it('treats null data as no hits', async () => {
    const { db } = fakeDb({ data: null, error: null });
    expect(await searchStudents(db, 'acc-1', 'zz')).toEqual([]);
  });

  it('throws the RPC error', async () => {
    const { db } = fakeDb({ data: null, error: { message: 'boom' } });
    await expect(searchStudents(db, 'acc-1', 'zz')).rejects.toThrow('boom');
  });
});

describe('matchLabel', () => {
  it.each([
    ['provisional_id', 'Provisional ID'],
    ['university_app_number', 'Univ. app no.'],
    ['registration_number', 'Reg. no.'],
    ['phone', 'Phone'],
    ['email', 'Email'],
    ['roll_number', 'Roll no.'],
    ['name', 'Name'],
  ] as const)('%s -> %s', (key, label) => {
    expect(matchLabel(key)).toBe(label);
  });
});
