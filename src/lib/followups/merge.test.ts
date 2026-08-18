import { describe, it, expect } from 'vitest';

import { renderFollowUpBody } from './merge';

describe('renderFollowUpBody', () => {
  it('greets by first name only', () => {
    expect(renderFollowUpBody('Hi {{name}}!', { name: 'Pratham Goel' })).toBe(
      'Hi Pratham!'
    );
  });

  it('falls back to "there" when the name is missing or blank', () => {
    expect(renderFollowUpBody('Hi {{name}}!', { name: null })).toBe(
      'Hi there!'
    );
    expect(renderFollowUpBody('Hi {{name}}!', { name: '   ' })).toBe(
      'Hi there!'
    );
  });

  it('merges the university with a fallback', () => {
    expect(
      renderFollowUpBody('Questions about {{university}}?', {
        university: 'LPU',
      })
    ).toBe('Questions about LPU?');
    expect(renderFollowUpBody('Questions about {{university}}?', {})).toBe(
      'Questions about your course options?'
    );
  });

  it('replaces every occurrence', () => {
    expect(renderFollowUpBody('{{name}} and {{name}}', { name: 'Asha' })).toBe(
      'Asha and Asha'
    );
  });

  it('leaves text without merge fields untouched', () => {
    expect(renderFollowUpBody('Plain text.', { name: 'X' })).toBe(
      'Plain text.'
    );
  });
});
