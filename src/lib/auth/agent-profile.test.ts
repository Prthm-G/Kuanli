import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveAgentProfileId } from './agent-profile';

const ACCOUNT = 'acct-1';
const PROFILES = [
  { id: 'prof-1', user_id: 'user-1', account_id: ACCOUNT },
  { id: 'prof-2', user_id: 'user-2', account_id: 'acct-other' },
];

/** Just enough of the client for `from('profiles').select().eq().eq().maybeSingle()`. */
function fakeDb(): SupabaseClient {
  return {
    from: () => {
      const filters: [string, unknown][] = [];
      const b = {
        select: () => b,
        eq: (k: string, v: unknown) => (filters.push([k, v]), b),
        maybeSingle: async () => ({
          data:
            PROFILES.find((p) =>
              filters.every(([k, v]) => p[k as keyof typeof p] === v)
            ) ?? null,
          error: null,
        }),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

describe('resolveAgentProfileId', () => {
  it('turns an auth user id (what the builder stores) into the profile id', async () => {
    expect(await resolveAgentProfileId(fakeDb(), ACCOUNT, 'user-1')).toBe(
      'prof-1'
    );
  });
  it('accepts a profile id as it is', async () => {
    expect(await resolveAgentProfileId(fakeDb(), ACCOUNT, 'prof-1')).toBe(
      'prof-1'
    );
  });
  it('never resolves someone in another account', async () => {
    expect(await resolveAgentProfileId(fakeDb(), ACCOUNT, 'user-2')).toBeNull();
    expect(await resolveAgentProfileId(fakeDb(), ACCOUNT, 'prof-2')).toBeNull();
  });
  it('returns null for an empty or unknown id', async () => {
    expect(await resolveAgentProfileId(fakeDb(), ACCOUNT, '')).toBeNull();
    expect(
      await resolveAgentProfileId(fakeDb(), ACCOUNT, undefined)
    ).toBeNull();
    expect(await resolveAgentProfileId(fakeDb(), ACCOUNT, 'nobody')).toBeNull();
  });
});
