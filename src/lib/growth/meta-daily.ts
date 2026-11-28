import { looksLikePii } from './validate';

/**
 * Boundary validation for POST /api/growth/meta-daily (KB-JOURNEY-R2).
 *
 * One Meta ad account day of ad x region rows, sent by the morning fetch on this host (devtools/morning-v2/validate.mjs)
 * after it has checked the same day itself. Rebuilt from known fields only; names are capped and scanned for phone- or
 * email-shaped text; region rows must sum to the account total within 1% (Rs 1 floor for tiny days). Meta reports no
 * chats or leads by region, so msg_started / leads are usually null.
 */

export const MAX_META_DAILY_BYTES = 1024 * 1024;
export const MAX_META_ROWS = 5000;
const MAX_NAME = 300;
const MAX_REGION = 120;

const META_ID = /^\d{5,25}$/;
const AD_ACCOUNT = /^\d{6,20}$/;
const TZ = /^(UTC|[A-Za-z]+(\/[A-Za-z0-9_+-]+)+)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type MetaDailyRow = {
  ad_id: string;
  ad_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  region: string;
  spend: number;
  impressions: number | null;
  clicks: number | null;
  msg_started: number | null;
  leads: number | null;
};

export type MetaDailyInput = {
  adAccountId: string;
  day: string;
  accountTz: string;
  total: { spend: number; impressions: number | null; clicks: number | null };
  rows: MetaDailyRow[];
};

type Result = { ok: true; value: MetaDailyInput } | { ok: false; error: string };

class Invalid extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** |total - sum| within 1% of the total, never tighter than Rs 1. */
export function sumWithin(total: number, sum: number): boolean {
  return Math.abs(total - sum) <= Math.max(0.01 * total, 1);
}

function money(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || Math.abs(v * 100 - Math.round(v * 100)) > 1e-6)
    throw new Invalid(`${path} must be an amount of at least 0 with at most 2 decimals`);
  return v;
}
function countOrNull(v: unknown, path: string): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Invalid(`${path} must be a whole number or null`);
  return v;
}
function idOrNull(v: unknown, path: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !META_ID.test(v)) throw new Invalid(`${path} must be a numeric id`);
  return v;
}
function nameOrNull(v: unknown, path: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length > MAX_NAME) throw new Invalid(`${path} must be text of at most ${MAX_NAME} characters`);
  if (looksLikePii(v)) throw new Invalid(`phone- or email-shaped value in ${path}`);
  return v;
}
function realDay(v: unknown): string {
  if (typeof v !== 'string' || !ISO_DATE.test(v) || Number.isNaN(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v)
    throw new Invalid('day must be a real YYYY-MM-DD date');
  const t = Date.parse(v);
  if (t > Date.now() + 86_400_000) throw new Invalid('day is in the future');
  if (t < Date.now() - 400 * 86_400_000) throw new Invalid('day is older than 400 days');
  return v;
}

export function validateMetaDaily(raw: string): Result {
  if (Buffer.byteLength(raw, 'utf8') > MAX_META_DAILY_BYTES) return { ok: false, error: 'body too large' };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'body is not JSON' };
  }
  try {
    if (!isObj(body)) throw new Invalid('body must be an object');
    if (typeof body.ad_account_id !== 'string' || !AD_ACCOUNT.test(body.ad_account_id))
      throw new Invalid('ad_account_id must be a numeric ad account id');
    const day = realDay(body.day);
    if (typeof body.account_tz !== 'string' || !TZ.test(body.account_tz) || body.account_tz.length > 64)
      throw new Invalid('account_tz must be an IANA timezone');
    if (!isObj(body.account_total)) throw new Invalid('account_total must be an object');
    const total = {
      spend: money(body.account_total.spend, 'account_total.spend'),
      impressions: countOrNull(body.account_total.impressions, 'account_total.impressions'),
      clicks: countOrNull(body.account_total.clicks, 'account_total.clicks'),
    };
    if (!Array.isArray(body.rows)) throw new Invalid('rows must be an array');
    if (body.rows.length > MAX_META_ROWS) throw new Invalid(`at most ${MAX_META_ROWS} rows`);
    const seen = new Set<string>();
    const rows = body.rows.map((x, n): MetaDailyRow => {
      if (!isObj(x)) throw new Invalid(`rows[${n}] must be an object`);
      const adId = idOrNull(x.ad_id, `rows[${n}].ad_id`);
      if (!adId) throw new Invalid(`rows[${n}].ad_id must be a numeric id`);
      if (typeof x.region !== 'string' || x.region.length < 1 || x.region.length > MAX_REGION)
        throw new Invalid(`rows[${n}].region must be text of 1 to ${MAX_REGION} characters`);
      const key = `${adId}|${x.region}`;
      if (seen.has(key)) throw new Invalid(`rows[${n}]: ad ${adId} region ${x.region} appears twice`);
      seen.add(key);
      return {
        ad_id: adId,
        ad_name: nameOrNull(x.ad_name, `rows[${n}].ad_name`),
        campaign_id: idOrNull(x.campaign_id, `rows[${n}].campaign_id`),
        campaign_name: nameOrNull(x.campaign_name, `rows[${n}].campaign_name`),
        adset_id: idOrNull(x.adset_id, `rows[${n}].adset_id`),
        adset_name: nameOrNull(x.adset_name, `rows[${n}].adset_name`),
        region: x.region,
        spend: money(x.spend, `rows[${n}].spend`),
        impressions: countOrNull(x.impressions, `rows[${n}].impressions`),
        clicks: countOrNull(x.clicks, `rows[${n}].clicks`),
        msg_started: countOrNull(x.msg_started, `rows[${n}].msg_started`),
        leads: countOrNull(x.leads, `rows[${n}].leads`),
      };
    });
    if (rows.length === 0 && total.spend > 0) throw new Invalid('rows are empty but the account total spend is above 0');
    const sum = rows.reduce((s, r) => s + r.spend, 0);
    if (!sumWithin(total.spend, sum))
      throw new Invalid(`region rows sum to ${sum.toFixed(2)} but the account total is ${total.spend.toFixed(2)}`);
    return { ok: true, value: { adAccountId: body.ad_account_id, day, accountTz: body.account_tz, total, rows } };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, error: e.message };
    throw e;
  }
}
