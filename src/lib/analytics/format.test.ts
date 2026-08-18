import { describe, it, expect } from 'vitest';

import { pct, formatMinutes } from './format';

describe('pct', () => {
  it('rounds to whole percent', () => {
    expect(pct(1, 3)).toBe('33%');
    expect(pct(2, 3)).toBe('67%');
  });

  it('never divides by zero', () => {
    expect(pct(0, 0)).toBe('—');
    expect(pct(5, 0)).toBe('—');
  });

  it('handles 0 and 100', () => {
    expect(pct(0, 10)).toBe('0%');
    expect(pct(10, 10)).toBe('100%');
  });
});

describe('formatMinutes', () => {
  it('shows seconds under a minute, never 0s', () => {
    expect(formatMinutes(0.75)).toBe('45s');
    expect(formatMinutes(0.001)).toBe('1s');
  });

  it('shows minutes under an hour', () => {
    expect(formatMinutes(4.4)).toBe('4m');
    expect(formatMinutes(59)).toBe('59m');
  });

  it('shows hours with one decimal under a day', () => {
    expect(formatMinutes(126)).toBe('2.1h');
  });

  it('shows days beyond 24h', () => {
    expect(formatMinutes(3 * 24 * 60)).toBe('3d');
  });
});
