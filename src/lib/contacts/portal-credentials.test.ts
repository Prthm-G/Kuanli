import { describe, expect, it } from 'vitest';

import { toMetadata, validateCredentialInput } from './portal-credentials';

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
