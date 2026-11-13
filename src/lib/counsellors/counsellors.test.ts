import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  addCounsellor,
  defaultDisplayName,
  isValidDisplayName,
  normalizeWaNumber,
  setCounsellorActive,
  telegramJoinLink,
} from './counsellors';

const P = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';
const K = '44444444-4444-4444-8444-444444444444';
// Fake number, built so no 10-digit literal sits in this public repo.
const TEN = `9${'0'.repeat(8)}1`;

function fakeDb(result: { data?: unknown; error?: { code?: string; message?: string } | null }) {
  const rpc = vi.fn(async () => ({ data: result.data ?? null, error: result.error ?? null }));
  return { db: { rpc } as unknown as SupabaseClient, rpc };
}

describe('normalizeWaNumber', () => {
  it('stores 91 followed by the 10 digits', () => {
    expect(normalizeWaNumber(TEN)).toBe(`91${TEN}`);
    expect(normalizeWaNumber(`+91 ${TEN.slice(0, 5)} ${TEN.slice(5)}`)).toBe(`91${TEN}`);
    expect(normalizeWaNumber(`91${TEN}`)).toBe(`91${TEN}`);
    expect(normalizeWaNumber(`0${TEN}`)).toBe(`91${TEN}`);
    expect(normalizeWaNumber(`${TEN.slice(0, 3)}-${TEN.slice(3)}`)).toBe(`91${TEN}`);
  });
  it('refuses anything else', () => {
    expect(normalizeWaNumber('')).toBeNull();
    expect(normalizeWaNumber('90000')).toBeNull();
    expect(normalizeWaNumber(`44${TEN}`)).toBeNull();
    expect(normalizeWaNumber(`${TEN}1`)).toBeNull();
    expect(normalizeWaNumber('90000abcde')).toBeNull();
    // Indian mobiles start 6-9.
    expect(normalizeWaNumber(`5${TEN.slice(1)}`)).toBeNull();
  });
});

describe('display name', () => {
  it('defaults to the first word of the name', () => {
    expect(defaultDisplayName('  Asha Rani  ')).toBe('Asha');
    expect(defaultDisplayName('A.K. Singh')).toBe('A.K.');
    expect(defaultDisplayName('Bhupinderjeetkaur')).toBe('Bhupinderjee');
    expect(defaultDisplayName('')).toBe('');
  });
  it('matches the database rule', () => {
    expect(isValidDisplayName('Asha')).toBe(true);
    expect(isValidDisplayName('Asha R.')).toBe(true);
    expect(isValidDisplayName('.Asha')).toBe(false);
    expect(isValidDisplayName('Asha1')).toBe(false);
    expect(isValidDisplayName('Abcdefghijklm')).toBe(false);
    expect(isValidDisplayName('')).toBe(false);
  });
});

describe('telegramJoinLink', () => {
  it('builds the start link', () => {
    expect(telegramJoinLink('example_leads_bot', 'abc123')).toBe(
      'https://t.me/example_leads_bot?start=abc123',
    );
    expect(telegramJoinLink('@example_leads_bot', 'abc')).toBe(
      'https://t.me/example_leads_bot?start=abc',
    );
  });
  it('gives null without a usable bot name', () => {
    expect(telegramJoinLink(undefined, 'abc')).toBeNull();
    expect(telegramJoinLink('', 'abc')).toBeNull();
    expect(telegramJoinLink('bad/name', 'abc')).toBeNull();
  });
});

describe('addCounsellor', () => {
  const input = { profileId: P, branchId: B, waNumber: TEN, displayName: ' Asha ' };

  it('calls add_counsellor with the normalised number and returns the join code', async () => {
    const { db, rpc } = fakeDb({
      data: [{ counsellor_id: K, telegram_start_code: 'code1', linked: false }],
    });
    expect(await addCounsellor(db, input)).toEqual({
      ok: true,
      counsellorId: K,
      startCode: 'code1',
      linked: false,
    });
    expect(rpc).toHaveBeenCalledWith('add_counsellor', {
      p_profile: P,
      p_branch: B,
      p_wa_number: `91${TEN}`,
      p_display_name: 'Asha',
    });
  });

  it('a linked existing entry comes back with no code', async () => {
    const { db } = fakeDb({ data: [{ counsellor_id: K, telegram_start_code: null, linked: true }] });
    expect(await addCounsellor(db, input)).toEqual({
      ok: true,
      counsellorId: K,
      startCode: null,
      linked: true,
    });
  });

  it('validates before any call', async () => {
    const { db, rpc } = fakeDb({});
    expect((await addCounsellor(db, { ...input, profileId: 'x' })).ok).toBe(false);
    expect(await addCounsellor(db, { ...input, branchId: '' })).toEqual({
      ok: false,
      error: 'Pick a branch',
    });
    expect(await addCounsellor(db, { ...input, waNumber: '123' })).toEqual({
      ok: false,
      error: 'Enter a 10-digit Indian mobile number',
    });
    expect((await addCounsellor(db, { ...input, displayName: '9Asha' })).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('passes the database message through, and names a 42501', async () => {
    const refused = fakeDb({ error: { code: 'P0001', message: 'That number is on another login' } });
    expect(await addCounsellor(refused.db, input)).toEqual({
      ok: false,
      error: 'That number is on another login',
    });
    const denied = fakeDb({ error: { code: '42501', message: 'permission denied' } });
    expect(await addCounsellor(denied.db, input)).toEqual({
      ok: false,
      error: 'Only an admin can add a counsellor.',
    });
  });

  it('treats an empty result as a failure', async () => {
    const { db } = fakeDb({ data: [] });
    expect((await addCounsellor(db, input)).ok).toBe(false);
  });
});

describe('setCounsellorActive', () => {
  it('calls set_counsellor_active', async () => {
    const { db, rpc } = fakeDb({});
    expect(await setCounsellorActive(db, K, true)).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith('set_counsellor_active', { p_counsellor: K, p_on: true });
  });

  it('explains the Telegram refusal', async () => {
    const { db } = fakeDb({
      error: { code: 'P0001', message: 'Counsellor has not joined Telegram yet' },
    });
    const out = await setCounsellorActive(db, K, true);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toMatch(/not joined the Telegram leads bot/);
  });

  it('names a 42501 and rejects a bad id before any call', async () => {
    const denied = fakeDb({ error: { code: '42501', message: 'permission denied' } });
    expect(await setCounsellorActive(denied.db, K, false)).toEqual({
      ok: false,
      error: 'Only an admin can change who takes leads.',
    });
    const { db, rpc } = fakeDb({});
    expect((await setCounsellorActive(db, 'nope', true)).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
});
