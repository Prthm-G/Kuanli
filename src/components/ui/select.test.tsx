import { createElement as h } from 'react';
import { describe, expect, it } from 'vitest';
import { collectSelectItems, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

describe('collectSelectItems', () => {
  it('reads value and label from options nested in the content, however they were built', () => {
    const tree = [
      h(SelectTrigger, { key: 't' }, h(SelectValue)),
      h(
        SelectContent,
        { key: 'c' },
        h(SelectItem, { key: 'n', value: '__none__' }, 'Not recorded'),
        ['call', 'email'].map((m) => h(SelectItem, { key: m, value: m }, m.toUpperCase())),
      ),
    ];
    expect(collectSelectItems(tree)).toEqual([
      { value: '__none__', label: 'Not recorded' },
      { value: 'call', label: 'CALL' },
      { value: 'email', label: 'EMAIL' },
    ]);
  });
  it('finds nothing in a tree with no options', () => {
    expect(collectSelectItems(h(SelectTrigger, null, h(SelectValue)))).toEqual([]);
  });
});
