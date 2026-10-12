import type { Count, GrowthSnapshotPayload } from './types';

/**
 * Boundary validation for POST /api/growth/snapshot (KB-GROWTH-R1).
 *
 * Hand-rolled (the codebase carries no schema library). The stored payload is
 * rebuilt from the known fields only, so unknown keys never reach the
 * database; strings are capped; counts must keep the scorecard's small-cell
 * suppression (1-2 arrive as "<3"); and every string value is scanned for
 * phone- or email-shaped text after stripping spaces, dashes, dots, brackets
 * and "+", so "98765 43210" is caught too. The page is aggregates only and is
 * not a place for lead PII. The base pattern is the scorecard's own
 * (reconcile/report.py).
 */

export const MAX_SNAPSHOT_BYTES = 64 * 1024;
export const MAX_STRING = 300;

export const PII_PATTERN = /(?<!\d)(91)?[6-9]\d{9}(?!\d)|@[a-z0-9-]+\.[a-z]/i;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type SnapshotInput = {
  accountId: string;
  snapshotDate: string;
  payload: GrowthSnapshotPayload;
};

type Result = { ok: true; value: SnapshotInput } | { ok: false; error: string };

class Invalid extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
// Round-trip so calendar-impossible dates (2026-02-31) fail here, not in Postgres.
const isDate = (v: unknown): v is string =>
  isStr(v) &&
  ISO_DATE.test(v) &&
  !Number.isNaN(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 10) === v;

/** True when a string carries a phone- or email-shaped value. */
export function looksLikePii(s: string): boolean {
  return PII_PATTERN.test(s) || PII_PATTERN.test(s.replace(/[\s\-.()+]/g, ''));
}

function str(v: unknown, path: string, scan = true): string {
  if (!isStr(v) || v.length > MAX_STRING)
    throw new Invalid(
      `${path} must be a string of at most ${MAX_STRING} characters`
    );
  if (scan && looksLikePii(v))
    throw new Invalid(`phone- or email-shaped value in ${path}`);
  return v;
}
function num(v: unknown, path: string): number {
  if (!isNum(v)) throw new Invalid(`${path} must be a number`);
  return v;
}
function count(v: unknown, path: string): Count {
  if (v === '<3') return v;
  if (!isNum(v) || !Number.isInteger(v) || v < 0)
    throw new Invalid(`${path} must be a count`);
  if (v === 1 || v === 2)
    throw new Invalid(`${path} must be suppressed as "<3"`);
  return v;
}
function date(v: unknown, path: string): string {
  if (!isDate(v)) throw new Invalid(`${path} must be a real YYYY-MM-DD date`);
  return v;
}
function dateOrNull(v: unknown, path: string): string | null {
  return v === null ? null : date(v, path);
}
function obj(v: unknown, path: string): Record<string, unknown> {
  if (!isObj(v)) throw new Invalid(`${path} must be an object`);
  return v;
}
function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new Invalid(`${path} must be an array`);
  return v;
}

function buildPayload(p: Record<string, unknown>): GrowthSnapshotPayload {
  if (p.v !== 1) throw new Invalid('payload.v must be 1');
  const i = obj(p.intake, 'payload.intake');
  const w = obj(p.window14, 'payload.window14');
  const s = obj(p.seo, 'payload.seo');
  return {
    v: 1,
    generated_at: str(p.generated_at, 'payload.generated_at', false),
    intake: {
      prefix: str(i.prefix, 'intake.prefix'),
      total: count(i.total, 'intake.total'),
      ads: count(i.ads, 'intake.ads'),
      target: num(i.target, 'intake.target'),
      target_ads: num(i.target_ads, 'intake.target_ads'),
      checkpoint: num(i.checkpoint, 'intake.checkpoint'),
      checkpoint_ads: num(i.checkpoint_ads, 'intake.checkpoint_ads'),
      checkpoint_date: date(i.checkpoint_date, 'intake.checkpoint_date'),
    },
    window14: {
      spend: num(w.spend, 'window14.spend'),
      enrolments: count(w.enrolments, 'window14.enrolments'),
      cpe: w.cpe === null ? null : num(w.cpe, 'window14.cpe'),
    },
    cells: arr(p.cells, 'payload.cells').map((x, n) => {
      const c = obj(x, `cells[${n}]`);
      return {
        cell: str(c.cell, `cells[${n}].cell`),
        spend: num(c.spend, `cells[${n}].spend`),
        conversations: num(c.conversations, `cells[${n}].conversations`),
        enrolled: count(c.enrolled, `cells[${n}].enrolled`),
      };
    }),
    ads: arr(p.ads, 'payload.ads').map((x, n) => {
      const a = obj(x, `ads[${n}]`);
      const adId = str(a.ad_id, `ads[${n}].ad_id`, false);
      if (!/^\d{1,25}$/.test(adId))
        throw new Invalid(`ads[${n}].ad_id must be a numeric id`);
      return {
        ad_id: adId,
        ad_name: str(a.ad_name, `ads[${n}].ad_name`),
        cell: str(a.cell, `ads[${n}].cell`),
        spend: num(a.spend, `ads[${n}].spend`),
        conversations: num(a.conversations, `ads[${n}].conversations`),
        enrolled: count(a.enrolled, `ads[${n}].enrolled`),
      };
    }),
    proposals: arr(p.proposals, 'payload.proposals').map((x, n) => {
      const q = obj(x, `proposals[${n}]`);
      return {
        kind: str(q.kind, `proposals[${n}].kind`),
        text: str(q.text, `proposals[${n}].text`),
      };
    }),
    blockers: arr(p.blockers, 'payload.blockers').map((x, n) => {
      const b = obj(x, `blockers[${n}]`);
      return {
        text: str(b.text, `blockers[${n}].text`),
        owner: str(b.owner, `blockers[${n}].owner`),
        since: dateOrNull(b.since, `blockers[${n}].since`),
      };
    }),
    seo: {
      status: str(s.status, 'seo.status'),
      checked: dateOrNull(s.checked, 'seo.checked'),
    },
  };
}

export function validateSnapshot(raw: string): Result {
  if (Buffer.byteLength(raw, 'utf8') > MAX_SNAPSHOT_BYTES)
    return { ok: false, error: 'body too large' };

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'body is not JSON' };
  }
  if (!isObj(body)) return { ok: false, error: 'body must be an object' };
  if (!isStr(body.account_id) || !UUID.test(body.account_id))
    return { ok: false, error: 'account_id must be a uuid' };
  if (!isDate(body.snapshot_date))
    return { ok: false, error: 'snapshot_date must be a real YYYY-MM-DD date' };
  if (!isObj(body.payload))
    return { ok: false, error: 'payload must be an object' };

  try {
    return {
      ok: true,
      value: {
        accountId: body.account_id,
        snapshotDate: body.snapshot_date,
        payload: buildPayload(body.payload),
      },
    };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, error: e.message };
    throw e;
  }
}
