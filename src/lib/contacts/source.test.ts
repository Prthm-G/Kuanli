import { describe, expect, it } from 'vitest';

import {
  CONTACT_SOURCES,
  MANUAL_CONTACT_SOURCES,
  normalizeContactSource,
  sourceLabel,
} from './source';

describe('normalizeContactSource', () => {
  it('accepts the canonical values', () => {
    expect(normalizeContactSource('organic')).toBe('organic');
    expect(normalizeContactSource('ads')).toBe('ads');
    expect(normalizeContactSource('reference')).toBe('reference');
    expect(normalizeContactSource('walkin')).toBe('walkin');
  });

  it('accepts common aliases and mixed case', () => {
    expect(normalizeContactSource('Ad')).toBe('ads');
    expect(normalizeContactSource('Walk-in')).toBe('walkin');
    expect(normalizeContactSource(' walk in ')).toBe('walkin');
  });

  it('returns undefined for junk and blanks', () => {
    expect(normalizeContactSource('billboard')).toBeUndefined();
    expect(normalizeContactSource('')).toBeUndefined();
    expect(normalizeContactSource('   ')).toBeUndefined();
    expect(normalizeContactSource(undefined)).toBeUndefined();
  });
});

describe('sourceLabel', () => {
  it('labels every known source', () => {
    expect(sourceLabel('organic')).toBe('Organic');
    expect(sourceLabel('ads')).toBe('Ad');
    expect(sourceLabel('reference')).toBe('Reference');
    expect(sourceLabel('walkin')).toBe('Walk-in');
  });

  it('falls back to Organic for missing values', () => {
    expect(sourceLabel(null)).toBe('Organic');
    expect(sourceLabel(undefined)).toBe('Organic');
  });
});

describe('MANUAL_CONTACT_SOURCES', () => {
  it('excludes only the system-derived ads value', () => {
    expect(MANUAL_CONTACT_SOURCES.map((s) => s.value)).toEqual(
      CONTACT_SOURCES.map((s) => s.value).filter((v) => v !== 'ads')
    );
  });
});
