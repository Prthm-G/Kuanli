import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The import and Lost or Not Interested cards, end to end through the route
 * with an in-memory database: such a card is never moved, for any intake; the
 * students are listed for a person to move. Read errors are reported.
 */

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  fail: new Set<string>(),
  sheetName: '2026-1 ONLINE',
  sheetRows: [] as Array<Record<string, string>>,
  dealUpdates: [] as Array<{ id: unknown; stage_id: unknown }>,
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ accountId: 'acc', userId: 'u1' }),
  toErrorResponse: (e: unknown) => {
    throw e;
  },
}));
vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: (s: string) => s }));
vi.mock('@/lib/admissions/xlsx-lite', () => ({
  readWorkbook: () => ({ sheetNames: [h.sheetName], sheet: () => h.sheetRows }),
}));

/** Just enough of the PostgREST builder for this route. `h.fail` makes a table's reads error. */
function query(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let mode: 'select' | 'insert' | 'update' = 'select';
  let payload: Row | null = null;
  const run = () => {
    if (mode === 'insert') {
      const row = {
        id: `${table}-${(h.db[table] ??= []).length + 1}`,
        ...payload,
      };
      h.db[table].push(row);
      return { data: [row], error: null, count: null };
    }
    const rows = (h.db[table] ?? []).filter((r) => filters.every((f) => f(r)));
    if (mode === 'update') {
      for (const r of rows) {
        Object.assign(r, payload);
        if (table === 'deals')
          h.dealUpdates.push({ id: r.id, stage_id: payload?.stage_id });
      }
      return { data: rows, error: null, count: null };
    }
    if (h.fail.has(table))
      return { data: null, error: { message: 'read failed' }, count: null };
    return { data: rows, error: null, count: rows.length };
  };
  const b = {
    select: () => b,
    insert: (p: Row) => ((mode = 'insert'), (payload = p), b),
    update: (p: Row) => ((mode = 'update'), (payload = p), b),
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
    in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), b),
    like: (c: string, v: string) => (
      filters.push((r) => String(r[c] ?? '').startsWith(v.replace(/%$/, ''))),
      b
    ),
    single: async () => ({ data: run().data?.[0] ?? null, error: null }),
    maybeSingle: async () => {
      const r = run();
      return { data: r.data?.[0] ?? null, error: r.error };
    },
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
      Promise.resolve(run()).then(ok, bad),
  };
  return b;
}
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({ from: query }),
}));

import { POST } from './route';

const HEADER = {
  A: 'S.NO.',
  B: 'NAME ',
  C: "FATHER'S NAME",
  D: 'COURSE',
  E: 'dd/mm/yr',
  F: 'EXAM CENTRE',
  G: 'REG NO',
  H: 'Password',
  I: 'Ref Person',
  J: 'CONATCT NO',
  K: 'CONATCT NO',
  L: 'TOTAL FEE',
  M: 'FEE PAID',
  N: 'FEE DUE',
  O: 'DISC.',
  P: 'Date',
  Q: 'REC. NO',
  R: 'BOOKS',
  S: 'EMAIL ID',
};
/** An enrolled student (a REG NO makes the row Enrolled) with a made-up number. */
const student = (n: number) => ({
  B: `Student ${n}`,
  D: 'B.Com',
  G: `R${n}`,
  J: `900000000${n}`,
  L: '8100',
  M: '8100',
});
const phone = (n: number) => `91900000000${n}`;

const STAGES = [
  'New Lead',
  'Qualified',
  'Application Started',
  'Enrolled',
  'Lost',
  'Not Interested',
];
function seed() {
  h.dealUpdates = [];
  h.fail = new Set();
  h.db = {
    pipelines: [{ id: 'p-lpu', account_id: 'acc', name: 'LPU Admissions' }],
    pipeline_stages: STAGES.map((name, i) => ({
      id: `s-${name}`,
      pipeline_id: 'p-lpu',
      name,
      position: i,
    })),
    contacts: [1, 2, 3, 4].map((n) => ({
      id: `c${n}`,
      account_id: 'acc',
      phone_normalized: phone(n),
      roll_number: `LD${n}`,
      intake_year: '26',
      intake_session: '1',
    })),
    deals: [
      {
        id: 'd1',
        contact_id: 'c1',
        pipeline_id: 'p-lpu',
        stage_id: 's-Lost',
        created_at: '2026-02-01T00:00:00Z',
      },
      {
        id: 'd2',
        contact_id: 'c2',
        pipeline_id: 'p-lpu',
        stage_id: 's-Not Interested',
        created_at: '2026-02-01T00:00:00Z',
      },
      // c3 has two cards: the newest is open, so that one moves forward and nothing is listed.
      {
        id: 'd3-old',
        contact_id: 'c3',
        pipeline_id: 'p-lpu',
        stage_id: 's-Lost',
        created_at: '2025-08-01T00:00:00Z',
      },
      {
        id: 'd3-new',
        contact_id: 'c3',
        pipeline_id: 'p-lpu',
        stage_id: 's-Qualified',
        created_at: '2026-03-01T00:00:00Z',
      },
      // c4 has two cards and the newest is Lost: listed, and neither card moves.
      {
        id: 'd4-old',
        contact_id: 'c4',
        pipeline_id: 'p-lpu',
        stage_id: 's-Qualified',
        created_at: '2025-08-01T00:00:00Z',
      },
      {
        id: 'd4-new',
        contact_id: 'c4',
        pipeline_id: 'p-lpu',
        stage_id: 's-Lost',
        created_at: '2026-03-01T00:00:00Z',
      },
    ],
  };
}

type Summary = {
  warnings: string[];
  exitCards: Array<{
    student: string;
    card: string;
    ldNumber: string | null;
    rollNumber: string | null;
  }>;
  stats: { importable: number; heldBack: number };
  flags: Array<{ code: string; level: string }>;
  written?: { deals: number; cardReadErrors: number };
};
async function post(dryRun: boolean): Promise<Summary> {
  const fd = new FormData();
  fd.append('file', new File([new Uint8Array([1])], 'register.xlsx'));
  const q = `${dryRun ? 'dryRun=1&' : ''}sheet=${encodeURIComponent(h.sheetName)}`;
  const res = await POST(
    new Request(`http://localhost/api/admissions/import?${q}`, {
      method: 'POST',
      body: fd,
    })
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Summary;
}
const stageOf = (id: string) => h.db.deals.find((d) => d.id === id)?.stage_id;

describe('admission import: Lost and Not Interested cards', () => {
  beforeEach(() => {
    h.sheetName = '2026-1 ONLINE';
    h.sheetRows = [HEADER, student(1), student(2), student(3), student(4)];
    seed();
  });

  it('the dry-run lists them with LD and roll numbers, newest card per contact, and says to move them by hand', async () => {
    const s = await post(true);
    expect(s.exitCards).toEqual([
      expect.objectContaining({
        student: 'Student 1',
        card: 'Lost',
        ldNumber: 'LD1',
        rollNumber: 'R1',
      }),
      expect.objectContaining({
        student: 'Student 2',
        card: 'Not Interested',
        ldNumber: 'LD2',
        rollNumber: 'R2',
      }),
      expect.objectContaining({
        student: 'Student 4',
        card: 'Lost',
        ldNumber: 'LD4',
        rollNumber: 'R4',
      }),
    ]);
    expect(s.warnings.join(' ')).toMatch(
      /3 student\(s\).*move them to Enrolled by hand/
    );
  });

  it('the import never moves them, for any intake, and lists them in the response', async () => {
    for (const tab of ['2026-1 ONLINE', '2025-2 ONLINE', '2027-1 ONLINE']) {
      seed();
      h.sheetName = tab;
      const s = await post(false);
      expect(stageOf('d1')).toBe('s-Lost');
      expect(stageOf('d2')).toBe('s-Not Interested');
      expect(stageOf('d4-new')).toBe('s-Lost');
      expect(stageOf('d4-old')).toBe('s-Qualified');
      expect(h.dealUpdates).toEqual([{ id: 'd3-new', stage_id: 's-Enrolled' }]); // only the open card moves
      expect(s.exitCards.map((c) => c.student)).toEqual([
        'Student 1',
        'Student 2',
        'Student 4',
      ]);
      expect(h.db.deals).toHaveLength(6); // no duplicate card for the two-card contacts
    }
  });

  it('duplicate phone rows are held back and listed at most once', async () => {
    h.sheetRows = [HEADER, student(1), student(1), student(2)];
    const s = await post(true);
    expect(s.stats.heldBack).toBe(2);
    expect(s.exitCards.map((c) => c.student)).toEqual(['Student 2']);
  });

  it('a 2062-1 tab is held back whole: nothing written, so year 62 never reaches the contacts', async () => {
    h.sheetName = '2062-1 ONLINE';
    const s = await post(false);
    expect(s.stats.importable).toBe(0);
    expect(s.stats.heldBack).toBe(4);
    expect(
      s.flags.filter(
        (f) => f.code === 'implausible-intake' && f.level === 'blocker'
      )
    ).toHaveLength(4);
    expect(s.warnings.join(' ')).toMatch(/2062-1/);
    expect(h.db.contacts.every((c) => c.intake_year === '26')).toBe(true);
    expect(h.dealUpdates).toEqual([]);
  });

  it('the dry-run says when it could not read the cards', async () => {
    h.fail.add('deals');
    const s = await post(true);
    expect(s.exitCards).toEqual([]);
    expect(s.warnings.join(' ')).toMatch(
      /Could not read the cards of 4 student\(s\)/
    );
  });

  it('the dry-run says when it could not read the board', async () => {
    h.fail.add('pipelines');
    const s = await post(true);
    expect(s.warnings.join(' ')).toMatch(
      /Could not read the LPU Admissions board/
    );
  });

  it('the import counts and reports rows whose cards could not be read, and creates or moves none', async () => {
    h.fail.add('deals');
    const s = await post(false);
    expect(s.written?.cardReadErrors).toBe(4);
    expect(s.written?.deals).toBe(0);
    expect(h.db.deals).toHaveLength(6);
    expect(s.warnings.join(' ')).toMatch(
      /4 student\(s\) skipped at the card step/
    );
  });
});
