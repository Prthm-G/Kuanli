import { describe, expect, it } from 'vitest';

import { duplicateLoginMessage, toMetadata, validateCredentialInput } from './portal-credentials';

describe('validateCredentialInput (create)', () => {
  const opts = { partial: false };

  it('accepts a full valid body and trims strings', () => {
    const result = validateCredentialInput(
      {
        label: '  LPU UMS ',
        portal_url: 'https://ums.lpu.in ',
        username: ' 12203456 ',
        password: 'hunter2!',
        notes: ' shared with student ',
      },
      opts,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        label: 'LPU UMS',
        kind: 'other',
        portal_url: 'https://ums.lpu.in',
        username: '12203456',
        password: 'hunter2!',
        notes: 'shared with student',
      },
    });
  });

  it('requires a label', () => {
    expect(
      validateCredentialInput({ password: 'x' }, opts),
    ).toEqual({ ok: false, error: 'Label is required' });
    expect(
      validateCredentialInput({ label: '   ', password: 'x' }, opts).ok,
    ).toBe(false);
  });

  it('requires a password', () => {
    expect(validateCredentialInput({ label: 'UMS' }, opts)).toEqual({
      ok: false,
      error: 'Password is required',
    });
    expect(
      validateCredentialInput({ label: 'UMS', password: '' }, opts).ok,
    ).toBe(false);
  });

  it('rejects oversized fields', () => {
    expect(
      validateCredentialInput(
        { label: 'x'.repeat(121), password: 'x' },
        opts,
      ).ok,
    ).toBe(false);
    expect(
      validateCredentialInput(
        { label: 'UMS', password: 'x'.repeat(1025) },
        opts,
      ).ok,
    ).toBe(false);
    expect(
      validateCredentialInput(
        { label: 'UMS', password: 'x', notes: 'x'.repeat(2001) },
        opts,
      ).ok,
    ).toBe(false);
  });

  it('rejects non-http portal URLs', () => {
    expect(
      validateCredentialInput(
        { label: 'UMS', password: 'x', portal_url: 'ftp://ums.lpu.in' },
        opts,
      ).ok,
    ).toBe(false);
    expect(
      validateCredentialInput(
        { label: 'UMS', password: 'x', portal_url: 'javascript:alert(1)' },
        opts,
      ).ok,
    ).toBe(false);
  });

  it('rejects non-object bodies', () => {
    expect(validateCredentialInput(null, opts).ok).toBe(false);
    expect(validateCredentialInput('nope', opts).ok).toBe(false);
  });
});

describe('validateCredentialInput (partial)', () => {
  const opts = { partial: true };

  it('allows absent label and password', () => {
    expect(validateCredentialInput({ username: 'abc' }, opts)).toEqual({
      ok: true,
      value: { username: 'abc' },
    });
  });

  it('still validates present fields', () => {
    expect(validateCredentialInput({ password: '' }, opts).ok).toBe(false);
    expect(validateCredentialInput({ label: '' }, opts).ok).toBe(false);
  });

  it('maps empty strings to null for clearable fields', () => {
    expect(
      validateCredentialInput(
        { portal_url: '', username: '', notes: '' },
        opts,
      ),
    ).toEqual({
      ok: true,
      value: { portal_url: null, username: null, notes: null },
    });
  });
});

describe('toMetadata', () => {
  it('picks only wire fields — ciphertext can never serialize', () => {
    const row = {
      id: 'id-1',
      contact_id: 'c-1',
      label: 'UMS',
      portal_url: null,
      username: 'u',
      notes: null,
      created_by: 'user-1',
      created_at: '2026-08-21',
      updated_at: '2026-08-21',
      password_ciphertext: 'iv:ct:tag',
      account_id: 'a-1',
    };
    const meta = toMetadata(row);
    expect(meta).not.toHaveProperty('password_ciphertext');
    expect(meta).not.toHaveProperty('account_id');
    expect(meta.label).toBe('UMS');
    expect(JSON.stringify(meta)).not.toContain('iv:ct:tag');
  });
});

describe('login kind', () => {
  it('defaults to other on create', () => {
    const r = validateCredentialInput({ label: 'L', password: 'x' }, { partial: false });
    expect(r).toMatchObject({ ok: true, value: { kind: 'other' } });
  });

  it.each(['provisional', 'registration', 'other'])('accepts %s', (kind) => {
    const r = validateCredentialInput({ label: 'L', password: 'x', kind }, { partial: false });
    expect(r).toMatchObject({ ok: true, value: { kind } });
  });

  it('rejects anything else', () => {
    for (const kind of ['admin', '', 'Provisional', 7, null]) {
      expect(
        validateCredentialInput({ label: 'L', password: 'x', kind }, { partial: false }).ok,
      ).toBe(false);
    }
  });

  it('leaves kind out of a partial update unless sent', () => {
    expect(validateCredentialInput({ label: 'L' }, { partial: true })).toEqual({
      ok: true,
      value: { label: 'L' },
    });
    expect(validateCredentialInput({ kind: 'provisional' }, { partial: true })).toEqual({
      ok: true,
      value: { kind: 'provisional' },
    });
  });

  it('toMetadata returns the kind and never the ciphertext', () => {
    const m = toMetadata({ id: 'a', contact_id: 'b', kind: 'provisional', password_ciphertext: 'zzz' });
    expect(m.kind).toBe('provisional');
    expect(JSON.stringify(m)).not.toContain('zzz');
    expect(toMetadata({ id: 'a', contact_id: 'b' }).kind).toBe('other');
  });
});

describe('duplicateLoginMessage', () => {
  it('maps 23505 to a friendly message by kind', () => {
    expect(duplicateLoginMessage({ code: '23505' }, 'provisional')).toBe(
      'This student already has a provisional login',
    );
    expect(duplicateLoginMessage({ code: '23505' }, 'registration')).toBe(
      'This student already has a registration login',
    );
  });
  it('returns null for other errors', () => {
    expect(duplicateLoginMessage({ code: '42501' }, 'provisional')).toBeNull();
    expect(duplicateLoginMessage(null, 'provisional')).toBeNull();
    expect(duplicateLoginMessage({ code: '23505' }, 'other')).toBeNull();
  });
});
