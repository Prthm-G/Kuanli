import { describe, it, expect } from 'vitest';

import { cardChips, toCardStatus, type CardStatus } from './card-status';

const base: CardStatus = {
  details: true,
  appFee: true,
  provisional: true,
  form: true,
  docsUploaded: 3,
  docsRequired: 5,
  courseFee: false,
  registration: false,
  hasPlan: false,
  reversed: false,
};

function find(chips: ReturnType<typeof cardChips>, label: string) {
  return chips.find((c) => c.label === label);
}

describe('cardChips', () => {
  it('at Provisional ID with the course fee in: fee received (done) and docs 3/5 (todo)', () => {
    const chips = cardChips({ ...base, courseFee: true }, 'Provisional ID');
    expect(find(chips, 'fee received')).toEqual({ label: 'fee received', tone: 'done' });
    expect(find(chips, 'docs 3/5')).toEqual({ label: 'docs 3/5', tone: 'todo' });
  });

  it('at Fee Submitted with documents incomplete: docs 3/5 (todo)', () => {
    const chips = cardChips({ ...base, courseFee: true }, 'Fee Submitted');
    expect(find(chips, 'docs 3/5')?.tone).toBe('todo');
  });

  it('shows complete documents as done', () => {
    const chips = cardChips({ ...base, docsUploaded: 5, courseFee: true }, 'Fee Submitted');
    expect(find(chips, 'docs 5/5')?.tone).toBe('done');
  });

  it('shows no docs chip when the university has no required documents', () => {
    const chips = cardChips({ ...base, docsUploaded: 0, docsRequired: 0 }, 'Provisional ID');
    expect(chips.some((c) => c.label.startsWith('docs'))).toBe(false);
  });

  it('registration without a fee plan: fee plan missing (warn)', () => {
    const chips = cardChips({ ...base, registration: true, hasPlan: false }, 'Fee Submitted');
    expect(find(chips, 'fee plan missing')).toEqual({ label: 'fee plan missing', tone: 'warn' });
  });

  it('registration with a fee plan: no plan warning', () => {
    const chips = cardChips({ ...base, registration: true, hasPlan: true }, 'Enrolled');
    expect(find(chips, 'fee plan missing')).toBeUndefined();
  });

  it('a reversed payment: fee reversed (warn)', () => {
    const chips = cardChips({ ...base, reversed: true }, 'Fee Submitted');
    expect(find(chips, 'fee reversed')).toEqual({ label: 'fee reversed', tone: 'warn' });
  });

  it('shows the next steps at Counselor Active and Application Started', () => {
    const early = { ...base, details: false, appFee: false, provisional: false, form: false };
    const ca = cardChips(early, 'Counselor Active');
    expect(find(ca, 'details')?.tone).toBe('todo');
    expect(find(ca, 'app fee')?.tone).toBe('todo');
    const as = cardChips({ ...early, details: true, appFee: true }, 'Application Started');
    expect(find(as, 'provisional ID')?.tone).toBe('todo');
  });

  it('shows nothing before Counselor Active, and nothing on closed cards', () => {
    for (const stage of ['New Lead', 'Engaged', 'Qualified', 'Lost', 'Not Interested', 'Some Other Stage']) {
      expect(cardChips({ ...base, reversed: true }, stage)).toEqual([]);
    }
  });
});

describe('toCardStatus', () => {
  it('maps an RPC row, defaulting missing counts to 0', () => {
    expect(
      toCardStatus({
        contact_id: 'c',
        details: true,
        app_fee: false,
        provisional: true,
        form: false,
        docs_uploaded: 2,
        docs_required: null,
        course_fee: true,
        registration: false,
        has_plan: true,
        reversed: false,
      })
    ).toEqual({
      details: true,
      appFee: false,
      provisional: true,
      form: false,
      docsUploaded: 2,
      docsRequired: 0,
      courseFee: true,
      registration: false,
      hasPlan: true,
      reversed: false,
    });
  });
});
