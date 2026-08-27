/**
 * Printable "today's calls" sheet (Excel-retirement roadmap, step 2): the
 * paper register a counsellor works through in a day, generated from the
 * follow-up worklist instead of kept by hand. Includes only what is workable
 * today — the overdue and today buckets — with a blank outcome column to
 * write on; the counsellor logs results back into the CRM afterwards.
 *
 * Pure HTML-string builder so the content is unit-testable; the page opens
 * it in a new window and calls print().
 */

import { bucketFor, describeDue } from './due';
import { METHOD_LABEL } from './types';
import type { WorklistRow } from './types';

function escapeHtml(v: string | null | undefined): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Overdue first (oldest debt first), then today's, each by due time. */
export function callSheetRows(
  rows: WorklistRow[],
  now: Date = new Date()
): WorklistRow[] {
  return rows
    .filter((r) => {
      const b = bucketFor(r.nextDueAt, now);
      return b === 'overdue' || b === 'today';
    })
    .sort((a, b) => a.nextDueAt.localeCompare(b.nextDueAt));
}

export function buildCallSheetHtml(
  rows: WorklistRow[],
  now: Date = new Date()
): string {
  const due = callSheetRows(rows, now);
  const dateLabel = now.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const body =
    due.length === 0
      ? '<p>No calls due today.</p>'
      : `<table>
  <thead>
    <tr><th>#</th><th>Name</th><th>Phone</th><th>University</th><th>Stage</th><th>Due</th><th>Next step</th><th>Last note</th><th class="outcome">Outcome / notes</th></tr>
  </thead>
  <tbody>
${due
  .map(
    (r, i) => `    <tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(r.name) || escapeHtml(r.phone)}</td>
      <td>${escapeHtml(r.phone)}</td>
      <td>${escapeHtml(r.university)}</td>
      <td>${escapeHtml(r.stageName)}</td>
      <td>${escapeHtml(describeDue(r.nextDueAt, now))}</td>
      <td>${escapeHtml(r.nextMethod ? METHOD_LABEL[r.nextMethod] : '')}</td>
      <td>${escapeHtml(r.summary)}</td>
      <td class="outcome"></td>
    </tr>`
  )
  .join('\n')}
  </tbody>
</table>`;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Call sheet — ${escapeHtml(dateLabel)}</title>
<style>
  body { font-family: system-ui, sans-serif; color: #111; margin: 24px; }
  h1 { font-size: 18px; margin: 0; }
  p.meta { color: #555; font-size: 12px; margin: 4px 0 16px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { border: 1px solid #bbb; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f2f2f2; font-weight: 600; }
  td.outcome, th.outcome { min-width: 160px; }
  @media print { body { margin: 8px; } }
</style>
</head>
<body>
<h1>Today's calls</h1>
<p class="meta">${escapeHtml(dateLabel)} · ${due.length} call${due.length === 1 ? '' : 's'} due · overdue first</p>
${body}
</body>
</html>`;
}
