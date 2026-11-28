import { describe, expect, it } from 'vitest';

import {
  mergeServerFields,
  parseGateError,
  punchedGateMissing,
  showsApplicationPanel,
  type PanelFields,
} from './panel-rules';

const stage = (pipeline_id: string, name: string) => ({ pipeline_id, name });
const board = (id: string) =>
  [
    'New Lead',
    'Counselor Active',
    'Application Started',
    'Enrolled',
    'Lost',
    'Not Interested',
  ].map((n) => stage(id, n));
const deal = (pipeline_id: string, stageName: string) => ({
  pipeline_id,
  stage: { name: stageName },
});

describe('showsApplicationPanel', () => {
  it('shows from the very first stage, so details + fee can move a New Lead in', () => {
    for (const name of [
      'New Lead',
      'Counselor Active',
      'Application Started',
      'Enrolled',
    ]) {
      expect(showsApplicationPanel([deal('p1', name)], board('p1'))).toBe(true);
    }
  });

  it('hides for Lost and Not Interested', () => {
    expect(showsApplicationPanel([deal('p1', 'Lost')], board('p1'))).toBe(
      false
    );
    expect(
      showsApplicationPanel([deal('p1', 'Not Interested')], board('p1'))
    ).toBe(false);
  });

  it('hides on a board with no Application Started stage', () => {
    const sales = [stage('p2', 'New Lead'), stage('p2', 'Won')];
    expect(showsApplicationPanel([deal('p2', 'New Lead')], sales)).toBe(false);
  });

  it('shows when any one deal qualifies', () => {
    const stages = [...board('p1'), stage('p2', 'New Lead')];
    expect(
      showsApplicationPanel(
        [deal('p2', 'New Lead'), deal('p1', 'Qualified')],
        stages
      )
    ).toBe(true);
  });

  it('hides with no deals', () => {
    expect(showsApplicationPanel([], board('p1'))).toBe(false);
  });
});

const f = (over: Partial<PanelFields> = {}): PanelFields => ({
  fatherName: '',
  program: '',
  university: '',
  specialization: '',
  universityAppNumber: '',
  provisionalAppId: '',
  registrationNumber: '',
  ...over,
});

describe('mergeServerFields', () => {
  it('keeps what was typed and not yet saved', () => {
    const baseline = f();
    const current = f({ fatherName: 'Typed', program: 'MBA' });
    const fresh = f({ provisionalAppId: 'P1' });
    expect(mergeServerFields(current, baseline, fresh)).toEqual(
      f({ fatherName: 'Typed', program: 'MBA', provisionalAppId: 'P1' })
    );
  });

  it('takes the server value for fields that were not touched', () => {
    const baseline = f({ program: 'BBA' });
    const current = f({ program: 'BBA' });
    expect(
      mergeServerFields(current, baseline, f({ program: 'MBA' })).program
    ).toBe('MBA');
  });

  it('ignores whitespace-only differences when deciding what is dirty', () => {
    const baseline = f({ program: 'BBA' });
    const current = f({ program: 'BBA ' });
    expect(
      mergeServerFields(current, baseline, f({ program: 'MBA' })).program
    ).toBe('MBA');
  });

  it('a field saved in the same action takes the saved value', () => {
    // Saved fields are no longer dirty once the baseline is the fresh server row.
    const fresh = f({ fatherName: 'Saved' });
    expect(mergeServerFields(fresh, f(), fresh)).toEqual(fresh);
  });
});

describe('punchedGateMissing', () => {
  const ok = {
    fatherName: 'Ram',
    program: 'MBA',
    university: 'LPU',
    email: 'first.last+x@college.edu.in',
  };

  it('returns nothing for full valid input, including a plus-address on a long domain', () => {
    expect(punchedGateMissing(ok)).toEqual([]);
  });

  it('lists each blank field, in gate order', () => {
    expect(
      punchedGateMissing({
        fatherName: ' ',
        program: '',
        university: '  ',
        email: '',
      })
    ).toEqual(['father_name', 'program', 'university', 'email']);
    expect(punchedGateMissing({ ...ok, program: '' })).toEqual(['program']);
  });

  it('flags placeholder and malformed emails like is_placeholder_email', () => {
    const bad = [
      'na@x.com',
      'n.a@x.com',
      'None@x.com',
      'test@x.com',
      'abc@x.com',
      'xyz@x.com',
      'noemail@x.com',
      'nomail@x.com',
      'no@x.com',
      'nil@x.com',
      'null@x.com',
      'demo@x.com',
      'sample@x.com',
      'aaaa@x.com',
      '1111@x.com',
      'a@x.com',
      'not-an-email',
      'a b@x.com',
      'who@nodot',
      'who@x.c',
    ];
    for (const email of bad) {
      expect(punchedGateMissing({ ...ok, email }), email).toEqual(['email']);
    }
  });

  it('trims and ignores case like the database', () => {
    expect(
      punchedGateMissing({ ...ok, email: '  Ram.K@College.EDU  ' })
    ).toEqual([]);
    expect(punchedGateMissing({ ...ok, email: ' TEST@x.com ' })).toEqual([
      'email',
    ]);
  });
});

describe('parseGateError', () => {
  it('reads the missing keys', () => {
    expect(parseGateError('missing: email,university')).toEqual([
      'email',
      'university',
    ]);
  });
  it('returns null for anything else', () => {
    expect(parseGateError('contact not found in this account')).toBeNull();
    expect(parseGateError('duplicate key value')).toBeNull();
    expect(parseGateError('missing: ')).toBeNull();
  });
});
