import { beforeEach, describe, expect, it, vi } from 'vitest';

// Every query the route builds is recorded, so the test asserts WHICH rows a
// statement touches rather than what a mock happens to return.
type Call = { table: string; op: string; filters: [string, string, unknown][] };
const calls: Call[] = [];
let updateError: { message: string } | null = null;

function builder(table: string, op: string) {
  const call: Call = { table, op, filters: [] };
  calls.push(call);
  const b: Record<string, unknown> = {};
  for (const f of ['in', 'eq', 'lte', 'gt', 'order']) {
    b[f] = (col: string, val: unknown) => {
      call.filters.push([f, col, val]);
      return b;
    };
  }
  b.select = () => b;
  b.limit = () => Promise.resolve({ data: [], error: null });
  b.then = (resolve: (v: unknown) => void) =>
    resolve(
      op === 'update'
        ? { data: updateError ? null : [], error: updateError }
        : { data: [], error: null }
    );
  return b;
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => ({
      update: () => builder(table, 'update'),
      select: () => builder(table, 'select'),
    }),
  }),
}));
vi.mock('@/lib/bot/auth', () => ({
  cameFromPublicInternet: () => false,
  verifySignature: () => false,
  verifySharedSecret: () => true,
}));
vi.mock('@/lib/meta/conversions', () => ({
  isWithinEventWindow: () => true,
  reportConversion: vi.fn(),
}));

const { POST } = await import('./route');
const call = () =>
  POST(
    new Request('http://localhost/api/bot/report-conversions', {
      method: 'POST',
      body: '{}',
    })
  );

beforeEach(() => {
  calls.length = 0;
  updateError = null;
});

describe('POST /api/bot/report-conversions - expiry', () => {
  it('expires only pending rows; an old failed row keeps its real reason', async () => {
    await call();
    const expiry = calls.find((c) => c.op === 'update');
    expect(expiry?.filters).toContainEqual(['eq', 'status', 'pending']);
    expect(
      expiry?.filters.some(
        ([, col, val]) => col === 'status' && Array.isArray(val)
      )
    ).toBe(false);
  });

  it('keeps delivering when the expiry update errors, and says so', async () => {
    updateError = { message: 'permission denied' };
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      expiry_error: 'permission denied',
    });
    expect(calls.some((c) => c.op === 'select')).toBe(true);
  });

  it('expires by event_time and leaves the due query selecting pending + failed inside the window', async () => {
    await call();
    const expiry = calls.find((c) => c.op === 'update');
    const due = calls.find((c) => c.op === 'select');
    expect(
      expiry?.filters.some(([f, col]) => f === 'lte' && col === 'event_time')
    ).toBe(true);
    expect(due?.filters).toContainEqual([
      'in',
      'status',
      ['pending', 'failed'],
    ]);
    expect(
      due?.filters.some(([f, col]) => f === 'gt' && col === 'event_time')
    ).toBe(true);
  });
});
