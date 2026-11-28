import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  JourneyBar,
  StudentHeader,
  type StudentHeaderProps,
} from './student-header';

describe('JourneyBar', () => {
  it('marks the current step', () => {
    const html = renderToStaticMarkup(
      h(JourneyBar, { stageName: 'Provisional ID' })
    );
    expect(html).toMatch(/aria-current="step"[^>]*>Provisional ID</);
    expect(html.match(/aria-current/g)).toHaveLength(1);
  });
  it('shows a red closed end and no current step for Lost', () => {
    const html = renderToStaticMarkup(h(JourneyBar, { stageName: 'Lost' }));
    expect(html).toContain('>Lost<');
    expect(html).not.toContain('aria-current');
  });
});

describe('StudentHeader', () => {
  const props: StudentHeaderProps = {
    name: 'S',
    phone: '919800000001',
    otherPhones: ['919800000002'],
    branchName: 'B1',
    ownerName: null,
    stageName: 'Qualified',
    provisionalAppId: null,
    universityAppNumber: null,
    registrationNumber: null,
    loading: false,
    error: false,
    warning: null,
  };
  it('keeps the value in the copy button name and has a live region', () => {
    const html = renderToStaticMarkup(h(StudentHeader, props));
    expect(html).not.toContain('aria-label="Copy');
    expect(html).toMatch(
      /<span class="sr-only">Copy <\/span>Branch<\/span>.*B1/
    );
    expect(html).toContain('aria-live="polite"');
  });
  it('shows the opened record as Phone and others as Also, WhatsApp on the primary only', () => {
    const html = renderToStaticMarkup(h(StudentHeader, props));
    expect(html.indexOf('Phone')).toBeLessThan(html.indexOf('919800000001'));
    expect(html).toMatch(/Also.*919800000002/);
    expect(html).toContain('wa.me/919800000001');
    expect(html).not.toContain('wa.me/919800000002');
  });
  it('has no WhatsApp link when the opened record has no phone', () => {
    const html = renderToStaticMarkup(
      h(StudentHeader, { ...props, phone: null })
    );
    expect(html).not.toContain('wa.me');
    expect(html).toMatch(/Also.*919800000002/);
  });
  it('warns only when a warning list is given', () => {
    expect(renderToStaticMarkup(h(StudentHeader, props))).not.toContain(
      'different students'
    );
    const html = renderToStaticMarkup(
      h(StudentHeader, { ...props, warning: ['A', 'B'] })
    );
    expect(html).toContain('These may be different students: A, B');
  });
  it('shows a dash while loading and Not set once loaded', () => {
    const loading = renderToStaticMarkup(
      h(StudentHeader, { ...props, loading: true })
    );
    expect(loading).not.toContain('Not set');
    expect(loading).toContain('Loading');
    expect(renderToStaticMarkup(h(StudentHeader, props))).toContain('Not set');
  });
});
