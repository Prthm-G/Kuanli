'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, CircleDashed, TriangleAlert } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import {
  approvableIds,
  buildSavePatch,
  canApproveAll,
  saveButtonLabel,
} from '@/lib/courses/review-actions';
import { loadFeeTemplates } from '@/lib/payments/queries';
import type { FeeTemplate } from '@/lib/payments/types';
import {
  composeCourseSheet,
  composeCourseSection,
  COURSE_SECTIONS,
  type CourseSection,
} from '@/lib/courses/compose';
import {
  courseLabel,
  normKey,
  PROSE_FIELDS,
  PROSE_LABEL,
  type CourseContentRow,
} from '@/lib/courses/types';
import { Button } from '@/components/ui/button';

/**
 * Course content review (migration 062): the wording the bot sends a lead the
 * moment they tap a programme.
 *
 * WHY THIS SCREEN EXISTS. Every row arrives from the ETL as `draft`, and only
 * `approved` rows are ever served — an unapproved course falls through to the
 * AI path instead. That makes unreviewed content unreachable rather than merely
 * unverified, which is the entire basis on which we seeded from existing data
 * without reviewing all 41 combinations up front. This screen is where that
 * debt gets paid down, at whatever pace the business allows.
 *
 * THE PREVIEW IS THE POINT. Reviewing seven prose fields in isolation does not
 * tell you whether the resulting message reads well, and the message is what
 * the student actually screenshots and forwards to a parent. So the preview
 * renders the REAL composer against the REAL fee rows — the identical function
 * the bot calls — rather than an approximation. If the fee block is missing
 * here, it will be missing on the lead's phone.
 *
 * Fees are deliberately not editable here. They live in `fee_templates` and are
 * read live at compose time; this screen owns wording only.
 */
export function CourseContentPanel() {
  const { accountId, user, canEditSettings } = useAuth();
  const [rows, setRows] = useState<CourseContentRow[] | null>(null);
  const [fees, setFees] = useState<FeeTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftEdits, setDraftEdits] = useState<Partial<CourseContentRow>>({});
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [showApproved, setShowApproved] = useState(false);
  const [feeLoadError, setFeeLoadError] = useState<string | null>(null);
  /**
   * fee-table spelling -> the canonical one the BOT actually sends
   * (queries.ts passes alias.canonical_specialization to the composer). Without
   * this the pane titled "exactly what the lead receives" rendered `MBA (Hr)`
   * where the lead gets `MBA (Human Resource)` - on 13 seeded rows the reviewer
   * was approving a title they had never seen.
   */
  const [canonicalSpec, setCanonicalSpec] = useState<Map<string, string>>(
    new Map()
  );
  /** null = the full sheet; otherwise one of the menu follow-ups. */
  const [previewSection, setPreviewSection] = useState<CourseSection | null>(
    null
  );

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;

    void (async () => {
      // Every attempt starts clean. Without this a single transient failure
      // pinned the "fee data could not be loaded" banner for the rest of the
      // session, telling reviewers the data was unreliable when it was fine -
      // the mirror image of the bug this banner was added to fix.
      setFeeLoadError(null);
      const supabase = createClient();
      const [content, feeRows, aliasRows] = await Promise.all([
        supabase
          .from('course_content')
          .select('*')
          .eq('account_id', accountId)
          .order('status')
          .order('program')
          .order('specialization'),
        // Do NOT swallow this. loadFeeTemplates throws on a real query
        // failure, and an empty array here makes the banner below claim "no
        // fee template matches this course" — sending a reviewer hunting for a
        // data problem that does not exist, or approving a course while
        // believing "no fees" is a fact rather than a fetch error.
        loadFeeTemplates(supabase, accountId).catch((err: Error) => {
          console.error('[course-content] fee template load failed', err);
          // Guarded: a superseded load rejecting AFTER a newer one succeeded
          // would re-pin the "fee data unreliable" banner over good data and
          // stop the reviewer approving. Same race the reset above fixed, in
          // the opposite direction.
          if (!cancelled) setFeeLoadError(err.message);
          return [] as FeeTemplate[];
        }),
        // Global reference data, readable by any authenticated member (062).
        // A failure only degrades titles back to the fee spelling.
        supabase
          .from('program_aliases')
          .select('fee_program, fee_specialization, canonical_specialization'),
      ]);

      if (cancelled) return;
      if (content.error) {
        setError(content.error.message);
        return;
      }
      type Raw = Record<string, unknown>;
      setRows(
        ((content.data ?? []) as unknown as Raw[]).map((r) => ({
          id: String(r.id),
          accountId: String(r.account_id),
          university: String(r.university ?? ''),
          mode: (r.mode as 'distance' | 'online') ?? 'distance',
          program: String(r.program ?? ''),
          specialization: String(r.specialization ?? ''),
          lang: (r.lang as 'en' | 'hi') ?? 'en',
          overview: (r.overview as string) ?? null,
          duration: (r.duration as string) ?? null,
          eligibility: (r.eligibility as string) ?? null,
          credits: (r.credits as string) ?? null,
          medium: (r.medium as string) ?? null,
          careers: (r.careers as string) ?? null,
          electives: (r.electives as string) ?? null,
          status: (r.status as 'draft' | 'approved') ?? 'draft',
          reviewedBy: (r.reviewed_by as string) ?? null,
          reviewedAt: (r.reviewed_at as string) ?? null,
          kbSyncedAt: (r.kb_synced_at as string) ?? null,
          overrideNotes: (r.override_notes as string) ?? null,
          updatedAt: String(r.updated_at ?? ''),
        }))
      );
      setFees(feeRows);
      const cmap = new Map<string, string>();
      for (const a of (aliasRows.data ?? []) as {
        fee_program: string;
        fee_specialization: string;
        canonical_specialization: string;
      }[]) {
        if (a.canonical_specialization) {
          cmap.set(
            `${normKey(a.fee_program)}|${normKey(a.fee_specialization)}`,
            a.canonical_specialization
          );
        }
      }
      setCanonicalSpec(cmap);
      setError(null);
    })();

    return () => {
      cancelled = true;
    };
  }, [accountId, reload]);

  const visible = useMemo(
    () => (rows ?? []).filter((r) => showApproved || r.status === 'draft'),
    [rows, showApproved]
  );

  const selected = useMemo(() => {
    const row = (rows ?? []).find((r) => r.id === selectedId) ?? null;
    return row ? { ...row, ...draftEdits } : null;
  }, [rows, selectedId, draftEdits]);

  /** The exact message the bot would send, composed by the real composer. */
  const preview = useMemo(() => {
    if (!selected) return null;
    // norm-matched, exactly as queries.ts matches at serve time. The strict ===
    // this replaces was latent-divergent: a differently-cased fee row would be
    // quoted by the bot and invisible in this preview.
    const matching = fees.filter(
      (f) =>
        f.university === selected.university &&
        f.mode === selected.mode &&
        normKey(f.program) === normKey(selected.program) &&
        normKey(f.specialization) === normKey(selected.specialization)
    );
    const canonical =
      canonicalSpec.get(
        `${normKey(selected.program)}|${normKey(selected.specialization)}`
      ) ?? selected.specialization;
    const input = {
      program: selected.program,
      specialization: canonical || undefined,
      mode: selected.mode,
      university: selected.university,
      prose: selected,
      fees: matching,
      lang: selected.lang,
    };
    // The menu buttons are answered by a different composer, so previewing only
    // the sheet left three of the five replies unreviewable — the reviewer had
    // no way to see what a lead tapping "Fee details" would actually get.
    return previewSection
      ? composeCourseSection(input, previewSection)
      : composeCourseSheet(input);
  }, [selected, fees, previewSection, canonicalSpec]);

  // Ask the composer directly rather than searching its output for a label.
  // Gated by which tab is showing, for the same reason queries.ts gates its
  // warnings: composeCourseSection reports feesRendered:false for eligibility
  // and admission by design, because they never show fees. Without this, the
  // destructive "no fees will be shown" banner fired on 2 of the 4 tabs for
  // every course, healthy or not — which trains a reviewer to ignore the one
  // banner that is supposed to stop a bad approval.
  const feeTabShowing = previewSection === null || previewSection === 'fees';
  const feeBlockMissing =
    preview !== null && feeTabShowing && !preview.feesRendered;
  const feeRowsDropped = feeTabShowing ? (preview?.feeRowsDropped ?? 0) : 0;

  const pendingCount = (rows ?? []).filter((r) => r.status === 'draft').length;

  function select(row: CourseContentRow) {
    setSelectedId(row.id);
    setDraftEdits({});
    setPreviewSection(null);
  }

  /**
   * Approve every outstanding draft in one action.
   *
   * Reviewing 41 courses one at a time is not a workflow anybody completes, and
   * this is not a one-off: `kb_source_hash` deliberately returns rows to draft
   * whenever the knowledge base moves underneath them, so a batch will land in
   * this queue again. Per-row approval stays for the careful pass; this exists
   * so the queue can actually be cleared.
   *
   * The confirm spells out what is being published, because "approved" here
   * means fee and eligibility claims start going to real students.
   */
  async function approveAll() {
    if (!user || !rows) return;

    // An unsaved edit would be published as its STORED text while the preview
    // kept showing the correction. Refuse rather than lie about what went live.
    if (!canApproveAll(Object.keys(draftEdits).length)) {
      toast.error(
        'Save or discard your current edit first — bulk approve would publish ' +
          'the stored text, not what you are looking at.'
      );
      return;
    }

    // Capture the ids at confirm time. The count shown and the rows written
    // must be the same set: the ETL can return rows to draft while this tab is
    // open, and an unbounded `.eq('status','draft')` would sweep those in.
    const ids = approvableIds(rows);
    if (ids.length === 0) return;
    const ok = window.confirm(
      `Approve ${ids.length} course ${ids.length === 1 ? 'sheet' : 'sheets'}?\n\n` +
        'They start being sent to leads immediately, including their fees and ' +
        'eligibility. You can return any of them to draft afterwards.'
    );
    if (!ok) return;

    setBusy(true);
    const now = new Date().toISOString();
    const { data: written, error: err } = await createClient()
      .from('course_content')
      .update({
        status: 'approved',
        reviewed_by: user.id,
        reviewed_at: now,
        updated_at: now,
      })
      .eq('account_id', accountId)
      .in('id', ids)
      .select('id');
    setBusy(false);

    if (err) {
      toast.error(`Could not approve: ${err.message}`);
      return;
    }
    // Report what was actually written, not what was counted before the call.
    const n = written?.length ?? 0;
    toast.success(
      `${n} ${n === 1 ? 'course is' : 'courses are'} now live to leads`
    );
    setReload((n2) => n2 + 1);
  }

  async function save(nextStatus?: 'draft' | 'approved') {
    if (!selected || !user) return;
    setBusy(true);
    const supabase = createClient();

    // Pin the row this save belongs to. `selected` is derived state and the
    // reviewer can click a different row while the request is in flight.
    const savingId = selected.id;
    const patch = buildSavePatch({
      intent:
        nextStatus === 'approved'
          ? 'approve'
          : nextStatus === 'draft'
            ? 'return-to-draft'
            : 'save-in-place',
      currentStatus: selected.status,
      prose: {
        overview: selected.overview,
        duration: selected.duration,
        eligibility: selected.eligibility,
        credits: selected.credits,
        medium: selected.medium,
        careers: selected.careers,
        electives: selected.electives,
      },
      userId: user.id,
      now: new Date().toISOString(),
    });

    // Optimistic concurrency. The ETL demotes a row to draft and rewrites its
    // prose the moment kb_source_hash shows the knowledge base moved, and it
    // can do that while this screen sits open. Without this predicate the
    // reviewer's patch lands on the NEW row: stale prose overwrites fresh KB
    // text, status goes back to approved, and kb_source_hash keeps the ETL's
    // new value - so the row then claims to be in sync and drift detection can
    // never fire for it again. That failure is silent on every side.
    const { data: written, error: err } = await supabase
      .from('course_content')
      .update(patch)
      .eq('id', savingId)
      .eq('updated_at', selected.updatedAt)
      .select('id');
    setBusy(false);

    if (!err && (written?.length ?? 0) === 0) {
      toast.error(
        'This course changed while you were editing it — most likely the ' +
          'content sync updated it. Nothing was saved. Reload and reapply your edit.'
      );
      setReload((n) => n + 1);
      return;
    }

    if (err) {
      toast.error(`Could not save: ${err.message}`);
      return;
    }
    toast.success(
      nextStatus === 'approved'
        ? `${courseLabel(selected)} is now live to leads`
        : nextStatus === 'draft'
          ? `${courseLabel(selected)} returned to draft`
          : 'Saved'
    );
    // Only clear the buffer if the reviewer is still on the row that was
    // saved. Clearing unconditionally wiped edits typed into a DIFFERENT row
    // while this request was in flight, and the textarea snapped back to the
    // stored value with no indication anything had been dropped.
    if (selectedId === savingId) setDraftEdits({});
    setReload((n) => n + 1);
  }

  if (error) {
    return (
      <p className="text-destructive text-sm">
        Could not load course content: {error}
      </p>
    );
  }
  if (!rows) return <p className="text-muted-foreground text-sm">Loading…</p>;

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold">Course content</h2>
        <p className="text-muted-foreground text-sm">
          What the bot sends when a lead picks a programme. Only approved
          courses are sent — the rest fall through to the AI assistant.
        </p>
        <p className="text-sm">
          <span className="font-medium">{pendingCount}</span> awaiting review
          {pendingCount > 0 && ' · these are still being answered by the AI'}
        </p>
      </header>

      {canEditSettings && pendingCount > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border p-3">
          <div className="text-sm">
            <p className="font-medium">Clear the review queue</p>
            <p className="text-muted-foreground">
              Approve all {pendingCount} outstanding{' '}
              {pendingCount === 1 ? 'course' : 'courses'} at once. Anything you
              change your mind about can go back to draft.
            </p>
          </div>
          <Button className="ml-auto" onClick={approveAll} disabled={busy}>
            Approve all {pendingCount}
          </Button>
        </div>
      )}

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={showApproved}
          onChange={(e) => setShowApproved(e.target.checked)}
        />
        Show approved courses too
      </label>

      <div className="grid gap-4 md:grid-cols-[minmax(0,20rem)_1fr]">
        {/* Review queue */}
        <ul className="max-h-[32rem] divide-y overflow-y-auto rounded-md border">
          {visible.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => select(r)}
                className={`hover:bg-muted flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                  r.id === selectedId ? 'bg-muted' : ''
                }`}
              >
                {r.status === 'approved' ? (
                  <CheckCircle2 className="size-4 shrink-0 text-green-600" />
                ) : (
                  <CircleDashed className="text-muted-foreground size-4 shrink-0" />
                )}
                <span className="truncate">
                  {courseLabel({
                    ...r,
                    specialization:
                      canonicalSpec.get(
                        `${normKey(r.program)}|${normKey(r.specialization)}`
                      ) ?? r.specialization,
                  })}
                </span>
                {r.overrideNotes && (
                  <TriangleAlert className="ml-auto size-4 shrink-0 text-amber-500" />
                )}
              </button>
            </li>
          ))}
          {visible.length === 0 && (
            <li className="text-muted-foreground px-3 py-6 text-center text-sm">
              Nothing awaiting review.
            </li>
          )}
        </ul>

        {/* Editor + live preview */}
        {selected ? (
          <div className="space-y-4 rounded-md border p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-medium">{courseLabel(selected)}</h3>
                <p className="text-muted-foreground text-xs">
                  {selected.status === 'approved'
                    ? `Approved${selected.reviewedAt ? ` on ${new Date(selected.reviewedAt).toLocaleDateString()}` : ''}`
                    : 'Draft — not sent to leads'}
                  {selected.kbSyncedAt &&
                    ` · synced from knowledge base ${new Date(selected.kbSyncedAt).toLocaleDateString()}`}
                </p>
              </div>
            </div>

            {selected.overrideNotes && (
              <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
                <TriangleAlert className="size-4 shrink-0 text-amber-600" />
                <div>
                  <p className="font-medium">
                    This course overrides the knowledge base
                  </p>
                  <p className="text-muted-foreground">
                    {selected.overrideNotes}
                  </p>
                </div>
              </div>
            )}

            {feeLoadError && (
              <div className="border-destructive/40 bg-destructive/5 flex gap-2 rounded-md border p-3 text-sm">
                <TriangleAlert className="text-destructive size-4 shrink-0" />
                <div>
                  <p className="font-medium">Fee data could not be loaded</p>
                  <p className="text-muted-foreground">
                    {feeLoadError}. The fee status shown below may be wrong — it
                    is not safe to judge pricing from this screen right now.
                  </p>
                </div>
              </div>
            )}

            {!feeLoadError && !feeBlockMissing && feeRowsDropped > 0 && (
              <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
                <TriangleAlert className="size-4 shrink-0 text-amber-600" />
                <div>
                  <p className="font-medium">
                    {feeRowsDropped} payment{' '}
                    {feeRowsDropped === 1 ? 'option is' : 'options are'} missing
                  </p>
                  <p className="text-muted-foreground">
                    Their figures do not add up, so they were left out. The lead
                    will assume those options are not offered.
                  </p>
                </div>
              </div>
            )}

            {!feeLoadError && feeBlockMissing && (
              <div className="border-destructive/40 bg-destructive/5 flex gap-2 rounded-md border p-3 text-sm">
                <TriangleAlert className="text-destructive size-4 shrink-0" />
                <div>
                  <p className="font-medium">No fees will be shown</p>
                  <p className="text-muted-foreground">
                    Either no fee template matches this course, or its figures
                    do not add up and were rejected. Fix it in Fee templates —
                    approving now sends a sheet with no prices.
                  </p>
                </div>
              </div>
            )}

            <div className="grid gap-3 lg:grid-cols-2">
              <div className="space-y-3">
                {PROSE_FIELDS.map((f) => (
                  <label key={f} className="block space-y-1">
                    <span className="text-xs font-medium">
                      {PROSE_LABEL[f]}
                    </span>
                    <textarea
                      className="bg-background w-full rounded-md border p-2 text-sm"
                      rows={f === 'overview' || f === 'electives' ? 3 : 2}
                      disabled={!canEditSettings}
                      value={selected[f] ?? ''}
                      onChange={(e) =>
                        setDraftEdits((d) => ({ ...d, [f]: e.target.value }))
                      }
                    />
                  </label>
                ))}
              </div>

              <div className="space-y-2">
                <span className="text-xs font-medium">
                  Preview — exactly what the lead receives
                </span>
                <div className="flex flex-wrap gap-1">
                  <button
                    type="button"
                    onClick={() => setPreviewSection(null)}
                    className={`rounded border px-2 py-0.5 text-xs ${previewSection === null ? 'bg-muted font-medium' : ''}`}
                  >
                    Course sheet
                  </button>
                  {COURSE_SECTIONS.map((sec) => (
                    <button
                      key={sec}
                      type="button"
                      onClick={() => setPreviewSection(sec)}
                      className={`rounded border px-2 py-0.5 text-xs ${previewSection === sec ? 'bg-muted font-medium' : ''}`}
                    >
                      {sec}
                    </button>
                  ))}
                </div>
                <pre className="bg-muted max-h-[24rem] overflow-y-auto rounded-md p-3 text-sm whitespace-pre-wrap">
                  {preview?.sheetText}
                </pre>
                {preview &&
                  (previewSection
                    ? preview.sheetText.length > 1024
                    : preview.sheetText.length > 4096) && (
                    <p className="text-destructive text-xs font-medium">
                      {preview.sheetText.length} characters — WhatsApp cuts this
                      at {previewSection ? 1024 : 4096}. The lead receives it
                      truncated mid-sentence; this preview shows the full text.
                      Shorten before approving.
                    </p>
                  )}
                <div className="flex flex-wrap gap-1">
                  {preview?.menuRows.map((m) => (
                    <span
                      key={m.id}
                      className="rounded border px-2 py-0.5 text-xs"
                    >
                      {m.title}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {canEditSettings && (
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => save()}
                  disabled={busy}
                  variant="outline"
                >
                  {saveButtonLabel(selected.status)}
                </Button>
                {selected.status === 'draft' ? (
                  <Button onClick={() => save('approved')} disabled={busy}>
                    Approve — start sending this
                  </Button>
                ) : (
                  <Button
                    onClick={() => save('draft')}
                    disabled={busy}
                    variant="outline"
                  >
                    Return to draft
                  </Button>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="text-muted-foreground flex items-center justify-center rounded-md border p-8 text-sm">
            Pick a course to review it.
          </div>
        )}
      </div>
    </div>
  );
}
