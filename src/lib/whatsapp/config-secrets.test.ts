import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Migration 099: a signed-in user's client cannot read whatsapp_config.access_token
// or verify_token, and a `*` select of the table fails outright. Token reads go
// through the service client after the route has resolved the caller's account.

const SRC = join(__dirname, '..', '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}
const files = sources(SRC).map((p) => ({ p: p.slice(SRC.length + 1), s: readFileSync(p, 'utf8') }));

describe('whatsapp_config secrets stay server-side (099)', () => {
  it('every config-resolver call passes the service client', () => {
    const calls = files
      .filter(({ p }) => !p.endsWith('config-resolver.ts'))
      .flatMap(({ p, s }) =>
        [...s.matchAll(/\b(getPrimaryConfig|getConfigForConversation)\(\s*([^,]+?)\s*,/g)].map((m) => ({
          p,
          arg: m[2].trim(),
          // `db` is accepted only where the file binds it to the service client.
          ok: m[2].trim() === 'supabaseAdmin()' || (m[2].trim() === 'db' && /const db = supabaseAdmin\(\)/.test(s)),
        })),
      );
    expect(calls.length).toBeGreaterThan(10);
    expect(calls.filter((c) => !c.ok).map((c) => `${c.p}: ${c.arg}`)).toEqual([]);
  });

  it('browser code never selects * or a token column from whatsapp_config', () => {
    const client = files.filter(({ s }) => /^['"]use client['"]/m.test(s));
    const bad = client.filter(({ s }) =>
      /from\(\s*['"`]whatsapp_config['"`]\s*\)\s*\.select\(\s*['"`][^'"`]*(\*|access_token|verify_token)/.test(s),
    );
    expect(client.length).toBeGreaterThan(0);
    expect(bad.map((f) => f.p)).toEqual([]);
  });
});
