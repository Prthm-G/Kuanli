import { describe, expect, it } from 'vitest';

import {
  displayLogin,
  emailToUsername,
  LOGIN_EMAIL_DOMAIN,
  loginEmailFor,
  mustChangePassword,
  normalizeUsername,
  passwordGate,
  usernameToEmail,
} from './username';

describe('normalizeUsername', () => {
  it('lower-cases and trims a valid username', () => {
    expect(normalizeUsername('  Riya ')).toBe('riya');
    expect(normalizeUsername('jas.preet_1')).toBe('jas.preet_1');
    expect(normalizeUsername('a-b')).toBe('a-b');
  });

  it('rejects bad shapes', () => {
    for (const bad of ['ab', 'a'.repeat(33), '.abc', 'abc.', 'ab c', 'ab@c', 'ąbc', '', 42, null]) {
      expect(normalizeUsername(bad)).toBeNull();
    }
    expect(normalizeUsername('a'.repeat(32))).toBe('a'.repeat(32));
  });
});

describe('login email mapping', () => {
  it('round-trips a username through its internal email', () => {
    const email = usernameToEmail('kabir');
    expect(email).toBe(`kabir@${LOGIN_EMAIL_DOMAIN}`);
    expect(emailToUsername(email)).toBe('kabir');
    expect(emailToUsername(`KABIR@${LOGIN_EMAIL_DOMAIN.toUpperCase()}`)).toBe('kabir');
  });

  it('gives no username for a real email', () => {
    expect(emailToUsername('someone@example.invalid')).toBeNull();
    expect(emailToUsername(`x@sub.${LOGIN_EMAIL_DOMAIN}`)).toBeNull();
    expect(emailToUsername(null)).toBeNull();
    expect(emailToUsername('no-at-sign')).toBeNull();
  });

  it('maps what is typed in the login box', () => {
    expect(loginEmailFor(' Meher ')).toBe(`meher@${LOGIN_EMAIL_DOMAIN}`);
    expect(loginEmailFor('Someone@Example.invalid')).toBe('someone@example.invalid');
    expect(loginEmailFor('  ')).toBeNull();
    expect(loginEmailFor('a b')).toBeNull();
  });

  it('shows the username, else the email', () => {
    expect(displayLogin(usernameToEmail('riya'))).toBe('riya');
    expect(displayLogin('someone@example.invalid')).toBe('someone@example.invalid');
    expect(displayLogin(undefined)).toBe('');
  });
});

describe('mustChangePassword', () => {
  it('is true only for an explicit true flag', () => {
    expect(mustChangePassword({ app_metadata: { must_change_password: true } })).toBe(true);
    expect(mustChangePassword({ app_metadata: { must_change_password: false } })).toBe(false);
    expect(mustChangePassword({ app_metadata: { must_change_password: 'true' } })).toBe(false);
    expect(mustChangePassword({ app_metadata: {} })).toBe(false);
    expect(mustChangePassword(null)).toBe(false);
  });
});

describe('passwordGate', () => {
  it('holds a pending member on /set-password', () => {
    expect(passwordGate('/set-password', true)).toBe('allow');
    expect(passwordGate('/api/auth/set-password', true)).toBe('allow');
    expect(passwordGate('/dashboard', true)).toBe('to-set-password');
    expect(passwordGate('/login', true)).toBe('to-set-password');
    expect(passwordGate('/inbox/abc', true)).toBe('to-set-password');
    expect(passwordGate('/api/account/members', true)).toBe('forbid');
    expect(passwordGate('/api/whatsapp/send', true)).toBe('forbid');
  });

  it('lets everyone else through and moves them off /set-password', () => {
    expect(passwordGate('/dashboard', false)).toBe('allow');
    expect(passwordGate('/api/account/members', false)).toBe('allow');
    expect(passwordGate('/set-password', false)).toBe('to-dashboard');
    expect(passwordGate('/api/auth/set-password', false)).toBe('allow');
  });
});
