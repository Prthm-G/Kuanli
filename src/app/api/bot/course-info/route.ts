/**
 * POST /api/bot/course-info  (KB-COURSEINFO-R4-40)
 *
 * Composes the deterministic course sheet that `Auretris - Main` sends the
 * moment a lead taps a programme. Called from a single new HTTP node on a new
 * `course_info` branch of `Route Selection`.
 *
 * This endpoint COMPOSES ONLY. It sends nothing to WhatsApp. n8n owns the send,
 * exactly as it already does for `Build Course List` / `Send Course List`, so
 * there is one place where outbound messages originate rather than two.
 *
 * Failure contract, and it matters: a miss is **404 with `found: false`**, never
 * a 500 and never an empty 200. The n8n HTTP node's error output is wired back
 * to `Enriched Prompt`, so a 404 degrades the turn to today's LLM behaviour. A
 * 500 would do the same thing but would also bury a real fault in the noise, and
 * an empty 200 would send the lead a blank message.
 */

import {
  cameFromPublicInternet,
  verifySharedSecret,
  verifySignature,
} from '@/lib/bot/auth';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { loadCourseSheet } from '@/lib/courses/queries';
import { COURSE_SECTIONS, type CourseSection } from '@/lib/courses/compose';

export const runtime = 'nodejs';

/** Reject a replayed request older than this. */
// Auth lives in src/lib/bot/auth.ts, shared with api/bot/report-conversions -
// two copies of an auth check is the two-places defect in its worst habitat.
// The rationale for the HMAC-or-shared-secret design is documented there.

interface CourseInfoBody {
  account_id?: string;
  university?: string;
  mode?: string;
  course?: string;
  specialization?: string;
  lang?: string;
  /** One of the sheet's menu buttons: fees | eligibility | admission. */
  section?: string;
}

/** This payload is a handful of short strings. Anything larger is not ours. */
const MAX_BODY_BYTES = 16 * 1024;

export async function POST(request: Request) {
  if (cameFromPublicInternet(request)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  // Checked BEFORE reading the body: HMAC verification structurally needs the
  // raw bytes, so without a ceiling an unauthenticated caller could force an
  // arbitrarily large allocation on every request.
  // Advisory fast-reject only: a chunked or header-less request skips this,
  // and a lying Content-Length passes it. The authoritative ceiling is the
  // byte check on the actual body below - do not remove that one in favour
  // of this one.
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload too large' }, { status: 413 });
  }

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload too large' }, { status: 413 });
  }

  const authorised =
    verifySignature(
      rawBody,
      request.headers.get('X-Webhook-Timestamp') ?? '',
      request.headers.get('X-Webhook-Signature') ?? ''
    ) || verifySharedSecret(request.headers.get('X-Webhook-Secret') ?? '');

  if (!authorised) {
    return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  }

  let body: CourseInfoBody;
  try {
    body = JSON.parse(rawBody) as CourseInfoBody;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  // JSON.parse("null") and JSON.parse('"x"') both SUCCEED, and destructuring
  // their result throws - a 500 on the one route whose contract says a miss is
  // never a 500, because a 500 here would bury a real fault in the noise.
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'body must be an object' }, { status: 400 });
  }

  const { account_id, university, mode, course } = body;
  if (!account_id || !university || !mode || !course) {
    return NextResponse.json(
      { error: 'account_id, university, mode and course are required' },
      { status: 400 }
    );
  }
  if (mode !== 'distance' && mode !== 'online') {
    return NextResponse.json(
      { error: 'mode must be distance or online' },
      { status: 400 }
    );
  }
  // Hindi content is deferred to v2; the column and the composer already handle
  // it, but nothing is seeded, so an `hi` request would find no approved row.
  const lang = body.lang === 'hi' ? 'hi' : 'en';

  // An unrecognised section would silently fall back to the whole sheet, which
  // reads as the bot ignoring what the lead tapped. Reject it instead.
  // Validated against the composer's own list, not a second copy of the same
  // three strings - the drift shape this codebase has already been bitten by.
  let section: CourseSection | undefined;
  // '' and null mean "no section asked", exactly as specialization is treated
  // below - n8n expressions render a missing value as '', and the two fields
  // sit one edit apart.
  if (body.section !== undefined && body.section !== null && body.section !== '') {
    if (!COURSE_SECTIONS.includes(body.section as CourseSection)) {
      return NextResponse.json(
        { error: `section must be one of ${COURSE_SECTIONS.join(', ')}` },
        { status: 400 }
      );
    }
    section = body.section as CourseSection;
  }

  let result;
  try {
    result = await loadCourseSheet(supabaseAdmin(), {
      accountId: account_id,
      university,
      mode,
      courseToken: course,
      specialization: body.specialization || undefined,
      lang,
      section,
    });
  } catch (err) {
    // A genuine fault, not a coverage gap. Still answered as a miss so the bot
    // degrades to the LLM rather than going silent at the lead.
    console.error(
      '[course-info] lookup failed',
      { university, mode, course },
      err
    );
    return NextResponse.json(
      { found: false, reason: 'lookup_failed' },
      { status: 404 }
    );
  }

  if (!result.found) {
    // The one outcome that was logged nowhere. On 2026-08-20 a lead asked for
    // a course the menu offered, this branch returned its 404, and no record
    // existed anywhere staff could see - the reason was computed and dropped.
    console.warn('[course-info] no sheet served', {
      university,
      mode,
      course,
      specialization: body.specialization ?? '',
      reason: result.reason,
    });
    return NextResponse.json(
      { found: false, reason: result.reason },
      { status: 404 }
    );
  }

  // A sheet went out but something about it is degraded. Silent to the lead,
  // so it must not be silent here - a dropped fee block in particular means a
  // live combination is quoting nothing where it should quote money.
  if (result.warnings.length) {
    console.warn('[course-info] degraded sheet', {
      university,
      mode,
      course,
      specialization: body.specialization ?? '',
      warnings: result.warnings,
    });
  }

  return NextResponse.json({
    found: true,
    sheet_text: result.sheetText,
    menu_rows: result.menuRows,
    // n8n passes these straight to `Tool - Send Brochure`, whose internals are
    // already deterministic - only its inputs were LLM-guessed before.
    brochure_path: result.brochurePath,
    warnings: result.warnings,
  });
}
