import type { RequiredDoc } from './types';

/**
 * Checklist progress for one applicant. "Ready" means every required document
 * is verified — the UI surfaces that as the moment to consider moving the
 * deal to Enrolled (a suggestion only; the counsellor decides, and per-course
 * nuances like UG students having no graduation marksheet stay human calls).
 */
export interface DocProgress {
  verified: number;
  received: number;
  total: number;
  ready: boolean;
}

export function computeProgress(required: RequiredDoc[]): DocProgress {
  const verified = required.filter((r) => r.status === 'verified').length;
  const received = required.filter((r) => r.status === 'received').length;
  return {
    verified,
    received,
    total: required.length,
    ready: required.length > 0 && verified === required.length,
  };
}
