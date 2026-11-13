import { createElement as h, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Select } from '@base-ui/react/select';
import { roleLabel } from './role-meta';

describe('roleLabel', () => {
  it('maps role values to their labels', () => {
    expect(roleLabel('agent')).toBe('Counsellor');
    expect(roleLabel('admin')).toBe('Admin');
    expect(roleLabel('owner')).toBe('Owner');
    expect(roleLabel('viewer')).toBe('Viewer');
  });
  it('falls back to the raw value for anything unknown', () => {
    expect(roleLabel('other')).toBe('other');
    expect(roleLabel(null)).toBe('');
  });

  it('the closed role picker shows "Counsellor" for the value agent', () => {
    // The bare Base UI parts, with no `items`: the case that showed "agent".
    const picker = (value: ReactNode | ((v: unknown) => ReactNode)) =>
      renderToStaticMarkup(
        h(Select.Root, { value: 'agent' }, h(Select.Trigger, null, h(Select.Value, { children: value }))),
      );
    expect(picker(undefined)).toMatch(/>agent</);
    const html = picker(roleLabel);
    expect(html).toContain('>Counsellor<');
    expect(html).not.toMatch(/>agent</);
  });
});
