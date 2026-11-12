import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  duplicateReference,
  loadAccountMembers,
  recordPayment,
  reversePayment,
} from './queries';
import type { NewPayment } from './types';

// A recorder in place of the Supabase client (the pattern of the webhook
// history test): every call is kept so the tests can read what was sent.
interface Op {
  table: string;
  op: 'select' | 'insert' | 'rpc';
  filters: [string, unknown][];
  payload?: unknown;
}
type Result = { data: unknown; error: { message: string } | null };

function recorder(handler: (op: Op) => Result = () => ({ data: null, error: null })) {
  const ops: Op[] = [];
  const builder = (table: string) => {
    const op: Op = { table, op: 'select', filters: [] };
    const b: Record<string, unknown> = {};
    const chain =
      (fn?: (...a: unknown[]) => void) =>
      (...a: unknown[]) => {
        fn?.(...a);
        return b;
      };
    Object.assign(b, {
      select: chain(),
      insert: chain((p) => Object.assign(op, { op: 'insert', payload: p })),
      eq: chain((c, v) => op.filters.push([String(c), v])),
      order: chain(),
      single: chain(),
      then: (res: (r: Result) => unknown, rej: (e: unknown) => unknown) => {
        ops.push(op);
        return Promise.resolve().then(() => handler(op)).then(res, rej);
      },
    });
    return b;
  };
  const client = {
    from: (t: string) => builder(t),
    rpc: async (name: string, args: unknown) => {
      const op: Op = { table: `rpc:${name}`, op: 'rpc', filters: [], payload: args };
      ops.push(op);
      return handler(op);
    },
  } as unknown as SupabaseClient;
  return { client, ops };
}

const ACCOUNT = '00000000-0000-4000-8096-000800000001';
const USER = '00000000-0000-4000-8096-000900000001';
const OTHER = '00000000-0000-4000-8096-000900000003';
const CONTACT = '00000000-0000-4000-8096-000400000008';
const PAYMENT = '00000000-0000-4000-8096-000500000001';

const base: NewPayment = {
  contactId: CONTACT,
  amount: 1500,
  currency: 'INR',
  method: 'upi',
  reference: 'REF-8096',
  head: 'semester',
  receivedBy: 'skeure',
};

describe('recordPayment', () => {
  it('sends head, received_by and collected_by in the insert', async () => {
    const { client, ops } = recorder(() => ({ data: { id: PAYMENT }, error: null }));
    await recordPayment(client, ACCOUNT, USER, { ...base, collectedBy: OTHER });
    expect(ops).toHaveLength(1);
    expect(ops[0].table).toBe('payments');
    expect(ops[0].payload).toMatchObject({
      head: 'semester',
      received_by: 'skeure',
      collected_by: OTHER,
      logged_by: USER,
    });
  });

  it('collected_by defaults to the caller', async () => {
    const { client, ops } = recorder(() => ({ data: { id: PAYMENT }, error: null }));
    await recordPayment(client, ACCOUNT, USER, base);
    expect(ops[0].payload).toMatchObject({ collected_by: USER });
  });

  it('rejects a cash payment without a receipt file, before any call', async () => {
    const { client, ops } = recorder();
    await expect(
      recordPayment(client, ACCOUNT, USER, { ...base, method: 'cash' })
    ).rejects.toThrow(/receipt/i);
    expect(ops).toHaveLength(0);
  });

  it('accepts a cash payment with a receipt file', async () => {
    const { client, ops } = recorder(() => ({ data: { id: PAYMENT }, error: null }));
    const receipt = new File(['x'], 'r.png', { type: 'image/png' });
    await recordPayment(client, ACCOUNT, USER, { ...base, method: 'cash', receipt });
    expect(ops).toHaveLength(1);
    expect(ops[0].payload).toMatchObject({ method: 'cash' });
  });
});

describe('reversePayment', () => {
  it('calls the reverse_payment RPC with the trimmed note', async () => {
    const { client, ops } = recorder();
    await reversePayment(client, PAYMENT, '  entered twice  ');
    expect(ops).toEqual([
      {
        table: 'rpc:reverse_payment',
        op: 'rpc',
        filters: [],
        payload: { p_payment_id: PAYMENT, p_note: 'entered twice' },
      },
    ]);
  });

  it('refuses an empty or blank note without calling the database', async () => {
    const { client, ops } = recorder();
    await expect(reversePayment(client, PAYMENT, '')).rejects.toThrow(/note/i);
    await expect(reversePayment(client, PAYMENT, '   ')).rejects.toThrow(/note/i);
    expect(ops).toHaveLength(0);
  });

  it('surfaces a database refusal', async () => {
    const { client } = recorder(() => ({ data: null, error: { message: 'not verified' } }));
    await expect(reversePayment(client, PAYMENT, 'x')).rejects.toThrow(/not verified/);
  });
});

describe('duplicateReference', () => {
  it.each(['upi', 'bank_transfer'] as const)(
    'asks the database for %s with a reference',
    async (method) => {
      const { client, ops } = recorder(() => ({ data: 2, error: null }));
      const n = await duplicateReference(client, ACCOUNT, method, ' REF-8096 ');
      expect(n).toBe(2);
      expect(ops).toEqual([
        {
          table: 'rpc:duplicate_payment_reference',
          op: 'rpc',
          filters: [],
          payload: { p_account_id: ACCOUNT, p_reference: 'REF-8096' },
        },
      ]);
    }
  );

  it.each(['cash', 'card', 'cheque', 'other'] as const)(
    'does not ask for %s',
    async (method) => {
      const { client, ops } = recorder();
      expect(await duplicateReference(client, ACCOUNT, method, 'REF-8096')).toBe(0);
      expect(ops).toHaveLength(0);
    }
  );

  it('does not ask without a reference', async () => {
    const { client, ops } = recorder();
    expect(await duplicateReference(client, ACCOUNT, 'upi', '  ')).toBe(0);
    expect(await duplicateReference(client, ACCOUNT, 'bank_transfer', null)).toBe(0);
    expect(ops).toHaveLength(0);
  });
});

describe('loadAccountMembers', () => {
  it('reads the account profiles for the Collected by picker', async () => {
    const { client, ops } = recorder(() => ({
      data: [
        { user_id: USER, full_name: 'Test Agent' },
        { user_id: OTHER, full_name: null },
      ],
      error: null,
    }));
    const members = await loadAccountMembers(client, ACCOUNT);
    expect(ops[0].table).toBe('profiles');
    expect(ops[0].filters).toContainEqual(['account_id', ACCOUNT]);
    expect(members).toEqual([
      { userId: USER, name: 'Test Agent' },
      { userId: OTHER, name: 'Member' },
    ]);
  });
});
