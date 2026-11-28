import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { JourneyBar } from './student-header';

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
