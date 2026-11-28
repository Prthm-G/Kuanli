import { describe, expect, it } from 'vitest';
import { readStudentParam, studentHref } from './drawer-url';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
describe('studentHref', () => {
  it('adds student to a bare path', () => expect(studentHref('/pipelines', '', ID)).toBe(`/pipelines?student=${ID}`));
  it('keeps other params (the inbox thread)', () => expect(studentHref('/inbox', '?c=abc', ID)).toBe(`/inbox?c=abc&student=${ID}`));
  it('replaces an open student', () => expect(studentHref('/inbox', `c=abc&student=${'1'.repeat(8)}`, ID)).toBe(`/inbox?c=abc&student=${ID}`));
  it('removes it on close', () => {
    expect(studentHref('/inbox', `?c=abc&student=${ID}`, null)).toBe('/inbox?c=abc');
    expect(studentHref('/follow-ups', `student=${ID}`, null)).toBe('/follow-ups');
  });
});
describe('readStudentParam', () => {
  it('accepts a uuid, lowercased', () => expect(readStudentParam(ID.toUpperCase())).toBe(ID));
  it('rejects anything else', () => {
    for (const v of [null, '', 'abc', `${ID}x`, "1' or 1=1"]) expect(readStudentParam(v)).toBeNull();
  });
});
