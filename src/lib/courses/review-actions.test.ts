import { describe, expect, it } from 'vitest';
import {
  approvableIds,
  buildSavePatch,
  canApproveAll,
  saveButtonLabel,
  type ReviewRow,
} from './review-actions';

const PROSE = { overview: 'o', eligibility: '10+2', duration: '3 years' };
const NOW = '2026-08-21T07:30:00.000Z';
const USER = 'user-1';

describe('approvableIds', () => {
  const rows: ReviewRow[] = [
    { id: 'a', status: 'draft' },
    { id: 'b', status: 'approved' },
    { id: 'c', status: 'draft' },
  ];

  it('returns exactly the drafts the reviewer was shown', () => {
    expect(approvableIds(rows)).toEqual(['a', 'c']);
  });

  it('never includes an already-approved row', () => {
    expect(approvableIds(rows)).not.toContain('b');
  });

  // The regression: the panel counted its snapshot but issued an unbounded
  // server-side .eq('status','draft'). An ETL run mid-session re-drafts rows,
  // and those rows must NOT be swept into the reviewer's confirmed set.
  it('is an id list, so rows that became draft later cannot be swept in', () => {
    const ids = approvableIds(rows);
    const afterEtlRedraft: ReviewRow[] = [
      ...rows,
      { id: 'etl-1', status: 'draft' },
      { id: 'etl-2', status: 'draft' },
    ];
    expect(approvableIds(afterEtlRedraft)).toContain('etl-1');
    // but the set captured at confirm time is unchanged
    expect(ids).toEqual(['a', 'c']);
  });

  it('is empty when nothing awaits review', () => {
    expect(approvableIds([{ id: 'b', status: 'approved' }])).toEqual([]);
  });
});

describe('canApproveAll', () => {
  it('allows the bulk approve when there is no unsaved edit', () => {
    expect(canApproveAll(0)).toBe(true);
  });

  // Otherwise the UPDATE publishes the stored text while the preview keeps
  // showing the reviewer's unsaved correction over the top of it.
  it('refuses while an edit is unsaved', () => {
    expect(canApproveAll(1)).toBe(false);
  });
});

describe('buildSavePatch', () => {
  it('stamps the reviewer when approving', () => {
    const p = buildSavePatch({
      intent: 'approve',
      currentStatus: 'draft',
      prose: PROSE,
      userId: USER,
      now: NOW,
    });
    expect(p).toMatchObject({
      status: 'approved',
      reviewed_by: USER,
      reviewed_at: NOW,
    });
  });

  it('clears the reviewer when returning to draft', () => {
    const p = buildSavePatch({
      intent: 'return-to-draft',
      currentStatus: 'approved',
      prose: PROSE,
      userId: USER,
      now: NOW,
    });
    expect(p).toMatchObject({
      status: 'draft',
      reviewed_by: null,
      reviewed_at: null,
    });
  });

  // The critical bug: a plain save on an approved row left status untouched, so
  // the edit went live under a "Save draft" label with a stale attribution.
  it('re-attests the reviewer when editing an already-approved row', () => {
    const p = buildSavePatch({
      intent: 'save-in-place',
      currentStatus: 'approved',
      prose: PROSE,
      userId: USER,
      now: NOW,
    });
    expect(p.status).toBe('approved');
    expect(p.reviewed_by).toBe(USER);
    expect(p.reviewed_at).toBe(NOW);
  });

  it('never silently leaves an approved row attributed to an older review', () => {
    const p = buildSavePatch({
      intent: 'save-in-place',
      currentStatus: 'approved',
      prose: PROSE,
      userId: USER,
      now: NOW,
    });
    expect(Object.keys(p)).toContain('reviewed_at');
  });

  it('does not publish a draft row that was merely saved', () => {
    const p = buildSavePatch({
      intent: 'save-in-place',
      currentStatus: 'draft',
      prose: PROSE,
      userId: USER,
      now: NOW,
    });
    expect(p.status).toBeUndefined();
    expect(p.reviewed_by).toBeUndefined();
  });

  it('always carries the prose and a fresh updated_at', () => {
    const p = buildSavePatch({
      intent: 'save-in-place',
      currentStatus: 'draft',
      prose: PROSE,
      userId: USER,
      now: NOW,
    });
    expect(p).toMatchObject({ ...PROSE, updated_at: NOW });
  });
});

describe('saveButtonLabel', () => {
  // Calling the publish-immediately path "Save draft" is what made the critical
  // bug invisible to the person clicking it.
  it('does not say "draft" on a row where saving publishes', () => {
    expect(saveButtonLabel('approved')).toBe('Save and keep live');
    expect(saveButtonLabel('approved').toLowerCase()).not.toContain('draft');
  });

  it('says draft on a draft row', () => {
    expect(saveButtonLabel('draft')).toBe('Save draft');
  });
});
