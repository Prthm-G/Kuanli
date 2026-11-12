import { describe, expect, it } from 'vitest';

import {
  mergeServerFields,
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
  specialization: '',
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
