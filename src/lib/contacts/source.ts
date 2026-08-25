/**
 * Lead-source vocabulary (migration 073). `source` is the stored CHANNEL
 * record on contacts; ad_headline/ad_body remain the ad-creative record
 * owned by the n8n bot. Shared by the contact form, detail view, CSV
 * import, queue and pipelines so the value set stays in one place.
 */

import type { ContactSource } from '@/types';

export const CONTACT_SOURCES: { value: ContactSource; label: string }[] = [
  { value: 'organic', label: 'Organic' },
  { value: 'ads', label: 'Ad' },
  { value: 'reference', label: 'Reference' },
  { value: 'walkin', label: 'Walk-in' },
];

/** Sources a counsellor can pick when CREATING a contact. 'ads' is
 *  system-derived from WhatsApp ad referrals, never chosen by hand here
 *  (the detail view still offers it as a correction surface). */
export const MANUAL_CONTACT_SOURCES = CONTACT_SOURCES.filter(
  (s) => s.value !== 'ads'
);

export function sourceLabel(source: ContactSource | null | undefined): string {
  return CONTACT_SOURCES.find((s) => s.value === source)?.label ?? 'Organic';
}

/** Tolerant parse for CSV cells and other free-form input. Returns
 *  undefined for anything unrecognised so callers fall back to the DB
 *  default rather than importing junk. */
export function normalizeContactSource(
  raw: string | undefined
): ContactSource | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === 'ad' || value === 'ads') return 'ads';
  if (value === 'walkin' || value === 'walk-in' || value === 'walk in') {
    return 'walkin';
  }
  if (value === 'organic' || value === 'reference') return value;
  return undefined;
}
