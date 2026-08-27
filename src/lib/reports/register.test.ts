import { describe, expect, it } from 'vitest';

import {
  intakeLabel,
  registerCsv,
  toRegisterRows,
  type RegisterRaw,
} from './register';

const base: RegisterRaw = {
  id: 'c-1',
  name: 'Asha',
  phone: '919800000001',
  roll_number: 'DLPU26J0001',
  university_roll_number: 'LPU-2026-4411',
  university: 'LPU',
  intake_year: '26',
  intake_session: 'Jul',
  source: 'ads',
  source_detail: null,
  created_at: '2026-08-01T10:00:00Z',
  conversations: [
    {
      interest_course: 'BA',
      interest_mode: 'Distance',
      interest_updated_at: '2026-08-01T10:00:00Z',
    },
    {
      interest_course: 'MBA',
      interest_mode: 'Online',
      interest_updated_at: '2026-08-05T10:00:00Z',
    },
  ],
};

describe('toRegisterRows', () => {
  it('keeps only enrolled contacts and picks the newest interest', () => {
    const rows = toRegisterRows([
      base,
      { ...base, id: 'c-2', university: null },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].course).toBe('MBA');
    expect(rows[0].mode).toBe('Online');
    expect(rows[0].intake).toBe('2026 Jul');
  });

  it('defaults source to organic and tolerates missing conversations', () => {
    const rows = toRegisterRows([
      { ...base, source: null, conversations: null },
    ]);
    expect(rows[0].source).toBe('organic');
    expect(rows[0].course).toBeNull();
  });
});

describe('intakeLabel', () => {
  it('renders year and session, alone or together', () => {
    expect(intakeLabel('26', 'Jul')).toBe('2026 Jul');
    expect(intakeLabel('26', null)).toBe('2026');
    expect(intakeLabel(null, 'Jul')).toBe('Jul');
    expect(intakeLabel(null, null)).toBe('');
  });
});

describe('registerCsv', () => {
  it('quotes fields and escapes interior quotes', () => {
    const rows = toRegisterRows([{ ...base, name: 'Asha "AJ" Jain, MBA' }]);
    const csv = registerCsv(rows);
    expect(csv.split('\n')).toHaveLength(2);
    expect(csv).toContain('"Asha ""AJ"" Jain, MBA"');
    expect(csv).toContain('"LPU-2026-4411"');
    expect(csv.split('\n')[0]).toContain('"University roll no"');
  });
});
