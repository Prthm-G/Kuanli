import { describe, expect, it } from 'vitest';

import {
  importMovesDeal,
  listExitCards,
  newestDealByContact,
} from './stage-move';

const stage = (name: string, position: number) => ({ name, position });
const NEW_LEAD = stage('New Lead', 0);
const QUALIFIED = stage('Qualified', 2);
const APP_STARTED = stage('Application Started', 4);
const PROVISIONAL_ID = stage('Provisional ID', 5);
const FORM_DOCS = stage('Form & Documents', 6);
const FEE_SUBMITTED = stage('Fee Submitted', 7);
const ENROLLED = stage('Enrolled', 8);
const LOST = stage('Lost', 9);
const NOT_INTERESTED = stage('Not Interested', 10);

describe('importMovesDeal', () => {
  it('moves an open card forward only', () => {
    expect(importMovesDeal(NEW_LEAD, APP_STARTED)).toBe(true);
    expect(importMovesDeal(QUALIFIED, ENROLLED)).toBe(true);
    expect(importMovesDeal(APP_STARTED, ENROLLED)).toBe(true);
    expect(importMovesDeal(ENROLLED, APP_STARTED)).toBe(false);
    expect(importMovesDeal(ENROLLED, ENROLLED)).toBe(false);
  });

  it('follows the 11-stage board: the three new stages sit between Application Started and Enrolled', () => {
    expect(
      importMovesDeal(
        { name: 'Provisional ID', position: 5 },
        { name: 'Application Started', position: 4 }
      )
    ).toBe(false);
    expect(
      importMovesDeal(
        { name: 'Fee Submitted', position: 7 },
        { name: 'Enrolled', position: 8 }
      )
    ).toBe(true);
    expect(importMovesDeal(APP_STARTED, PROVISIONAL_ID)).toBe(true);
    expect(importMovesDeal(FORM_DOCS, FEE_SUBMITTED)).toBe(true);
    expect(importMovesDeal(FEE_SUBMITTED, APP_STARTED)).toBe(false);
    expect(importMovesDeal(ENROLLED, FEE_SUBMITTED)).toBe(false);
  });

  it('never moves a Lost or Not Interested card, for any target', () => {
    for (const from of [LOST, NOT_INTERESTED]) {
      for (const to of [
        NEW_LEAD,
        APP_STARTED,
        ENROLLED,
        LOST,
        NOT_INTERESTED,
      ]) {
        expect(importMovesDeal(from, to)).toBe(false);
      }
    }
  });
});

describe('newestDealByContact', () => {
  it('picks the newest card per contact, an undated one counting as oldest', () => {
    const picked = newestDealByContact([
      {
        id: 'old',
        contact_id: 'c1',
        stage_id: 's-lost',
        created_at: '2026-01-05T00:00:00Z',
      },
      {
        id: 'new',
        contact_id: 'c1',
        stage_id: 's-qualified',
        created_at: '2026-08-01T00:00:00Z',
      },
      { id: 'undated', contact_id: 'c1', stage_id: 's-lost', created_at: null },
      { id: 'only', contact_id: 'c2', stage_id: 's-lost', created_at: null },
    ]);
    expect(picked.get('c1')?.id).toBe('new');
    expect(picked.get('c2')?.id).toBe('only');
  });
});

describe('listExitCards', () => {
  const row = (
    n: number,
    stageName: 'Enrolled' | 'Application Started' = 'Enrolled'
  ) => ({
    name: `Student ${n}`,
    rowNumber: n + 1,
    importPhone: n ? `91000000000${n}` : '',
    universityRollNumber: stageName === 'Enrolled' ? `R${n}` : '',
    stage: stageName,
  });
  const contactByPhone = new Map(
    [1, 2, 3, 4].map((n) => [
      `91000000000${n}`,
      { id: `c${n}`, ldNumber: n === 4 ? null : `LD${n}` },
    ])
  );
  const stageByContact = new Map([
    ['c1', 'Lost'],
    ['c2', 'Not Interested'],
    ['c3', 'Qualified'], // newest card open: an ordinary forward move, not listed
    ['c4', 'Lost'],
  ]);

  it('lists each student whose newest card is Lost or Not Interested, once, with LD and roll numbers', () => {
    const rows = [
      row(1),
      row(1),
      row(2),
      row(3),
      row(4, 'Application Started'),
      row(5),
      row(0),
    ];
    expect(listExitCards(rows, contactByPhone, stageByContact)).toEqual([
      {
        student: 'Student 1',
        row: 2,
        card: 'Lost',
        sheetStage: 'Enrolled',
        ldNumber: 'LD1',
        rollNumber: 'R1',
      },
      {
        student: 'Student 2',
        row: 3,
        card: 'Not Interested',
        sheetStage: 'Enrolled',
        ldNumber: 'LD2',
        rollNumber: 'R2',
      },
      {
        student: 'Student 4',
        row: 5,
        card: 'Lost',
        sheetStage: 'Application Started',
        ldNumber: null,
        rollNumber: null,
      },
    ]);
  });
});
