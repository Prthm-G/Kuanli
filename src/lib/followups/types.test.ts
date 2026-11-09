import { describe, expect, it } from 'vitest';

import { nextStepCopy } from './types';

describe('nextStepCopy', () => {
  it('Not interested: says where the lead goes and makes the date "Contact again on"', () => {
    const c = nextStepCopy('not_interested');
    expect(c.label).toBe('Contact again on (optional)');
    expect(c.notice).toMatch(/Not interested list/);
    expect(c.help).not.toMatch(/—/);
  });
  it('every other outcome keeps the normal next follow-up', () => {
    for (const o of [
      '',
      'connected',
      'no_answer',
      'callback_requested',
      'converted',
    ] as const) {
      const c = nextStepCopy(o);
      expect(c.label).toBe('Next follow-up');
      expect(c.notice).toBeNull();
    }
  });
});
