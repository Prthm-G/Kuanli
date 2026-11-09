import { describe, expect, it } from 'vitest';
import type { Conversation } from '@/types';
import {
  filterByNumber,
  numberFilterOptions,
  numberLabelsFor,
} from './numbers';

const BOT = '100000000000001';
const C_A = '100000000000002';
const C_B = '100000000000003';
const OLD = '100000000000004';

const configs = [
  {
    phone_number_id: BOT,
    display_phone_number: '+91 00000 00001',
    is_primary: true,
  },
  {
    phone_number_id: C_A,
    display_phone_number: '+91 00000 00002',
    is_primary: false,
  },
  { phone_number_id: C_B, display_phone_number: null, is_primary: false },
];
const counsellors = [
  { phone_number_id: C_B, display_name: 'Bee' },
  { phone_number_id: C_A, display_name: 'Ay' },
  { phone_number_id: null, display_name: 'Not linked' },
];

const conv = (id: string, phone_number_id: string | null) =>
  ({ id, phone_number_id }) as unknown as Conversation;

describe('numberLabelsFor', () => {
  it('names counsellor numbers after the counsellor and the main number Bot', () => {
    expect(numberLabelsFor(configs, counsellors)).toEqual({
      [BOT]: 'Bot',
      [C_A]: 'Ay',
      [C_B]: 'Bee',
    });
  });

  it('another connected number keeps its display number', () => {
    expect(
      numberLabelsFor(
        [
          ...configs,
          {
            phone_number_id: OLD,
            display_phone_number: '+91 00000 00004',
            is_primary: false,
          },
        ],
        counsellors
      )[OLD]
    ).toBe('+91 00000 00004');
  });

  it('no counsellor numbers: the labels stay as before (display numbers)', () => {
    expect(numberLabelsFor(configs, [])).toEqual({
      [BOT]: '+91 00000 00001',
      [C_A]: '+91 00000 00002',
      [C_B]: C_B,
    });
  });
});

describe('numberFilterOptions', () => {
  it('All, Bot, then each linked counsellor number by name', () => {
    expect(numberFilterOptions(counsellors)).toEqual([
      { value: 'all', label: 'All numbers' },
      { value: 'bot', label: 'Bot' },
      { value: C_A, label: 'Ay' },
      { value: C_B, label: 'Bee' },
    ]);
  });

  it('none when no counsellor number is linked (nothing to filter)', () => {
    expect(
      numberFilterOptions([{ phone_number_id: null, display_name: 'x' }])
    ).toEqual([]);
  });
});

describe('filterByNumber', () => {
  const list = [
    conv('1', BOT),
    conv('2', C_A),
    conv('3', C_B),
    conv('4', OLD),
    conv('5', null),
  ];
  const ids = (l: Conversation[]) => l.map((c) => c.id);
  const counsellorIds = new Set([C_A, C_B]);

  it('all keeps everything', () => {
    expect(ids(filterByNumber(list, 'all', counsellorIds))).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
  });
  it('Bot is every chat off the counsellor numbers, old numbers included', () => {
    expect(ids(filterByNumber(list, 'bot', counsellorIds))).toEqual([
      '1',
      '4',
      '5',
    ]);
  });
  it('a counsellor number keeps that number only', () => {
    expect(ids(filterByNumber(list, C_A, counsellorIds))).toEqual(['2']);
  });
});
