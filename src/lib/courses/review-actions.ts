/**
 * The decisions the course review panel makes, extracted so they can be tested
 * (KB-COURSEINFO-R5-44).
 *
 * `course_content.status = 'approved'` is the only thing keeping unreviewed fee
 * and eligibility claims off a real student's phone. Both bugs this file exists
 * to prevent were found by code review rather than by a test, because the logic
 * lived inline in a `'use client'` component and this repo's suite is
 * node-environment only. Pulling the decisions out costs no new dependency and
 * makes them assertable.
 *
 * The component keeps the rendering and the effect wiring. Everything here is
 * pure.
 */

export interface ReviewRow {
  id: string;
  status: 'draft' | 'approved';
}

/**
 * The rows "Approve all N" is allowed to write.
 *
 * THE BUG THIS REPLACES. The panel counted drafts from its own loaded snapshot,
 * showed that number in the confirm dialog and the success toast, and then
 * issued an UPDATE predicated on `.eq('status','draft')` server-side with no id
 * list. Those are not the same set. `kb_source_hash` returns rows to draft
 * whenever the ETL sees the KB move underneath them, so an ETL run while the tab
 * sits open silently widens the write: the reviewer confirms "Approve 3" and 23
 * rows go live, 20 of them with freshly-changed fees that nobody has read, while
 * the toast reports 3.
 *
 * Returning ids rather than a count is the fix. The caller must constrain the
 * UPDATE with `.in('id', …)` so the set written is exactly the set counted.
 */
export function approvableIds(rows: readonly ReviewRow[]): string[] {
  return rows.filter((r) => r.status === 'draft').map((r) => r.id);
}

/**
 * Whether "Approve all" may run at all.
 *
 * THE BUG THIS REPLACES. `draftEdits` is a bare object with no owning row id,
 * and `approveAll` cleared neither it nor the selection. So a reviewer could
 * correct a wrong eligibility, not save, hit "Approve all", and have the UPDATE
 * publish the STORED (wrong) text - while the editor and the pane titled
 * "Preview - exactly what the lead receives" both went on showing the correction
 * merged back over the refetched row. The reviewer's fix was on no lead's phone
 * and the screen asserted that it was.
 *
 * Refusing while an unsaved edit exists is the smallest guard that cannot lie.
 */
export function canApproveAll(unsavedEditCount: number): boolean {
  return unsavedEditCount === 0;
}

export type SaveIntent = 'approve' | 'return-to-draft' | 'save-in-place';

/**
 * What a save writes.
 *
 * THE BUG THIS REPLACES. A plain save built a patch with no `status` key. On a
 * row that was already approved the row stayed approved, so the edit reached the
 * next lead immediately - under a button labelled "Save draft" - and
 * `reviewed_by`/`reviewed_at` were left untouched, so the audit trail went on
 * attributing text that did not exist when the row was approved.
 *
 * The resolution is NOT to demote the row. Demoting takes a working course dark
 * and sends the next lead to the out-of-quota LLM, which is worse for the lead
 * than a slightly edited sheet. Instead, editing an approved row re-stamps the
 * reviewer: the human is asserting this exact text, which is what `approved` is
 * supposed to mean. The component is responsible for labelling that button
 * honestly ("Save and keep live", never "Save draft") when the row is approved.
 */
export function buildSavePatch(args: {
  intent: SaveIntent;
  currentStatus: 'draft' | 'approved';
  prose: Record<string, string | null>;
  userId: string;
  now: string;
}): Record<string, unknown> {
  const { intent, currentStatus, prose, userId, now } = args;
  const patch: Record<string, unknown> = { ...prose, updated_at: now };

  if (intent === 'approve') {
    // The DB CHECK refuses an approval without both, so send them together
    // rather than relying on the component to remember.
    patch.status = 'approved';
    patch.reviewed_by = userId;
    patch.reviewed_at = now;
    return patch;
  }
  if (intent === 'return-to-draft') {
    patch.status = 'draft';
    patch.reviewed_by = null;
    patch.reviewed_at = null;
    return patch;
  }
  // save-in-place: only meaningful on an approved row, where it must re-attest.
  if (currentStatus === 'approved') {
    patch.status = 'approved';
    patch.reviewed_by = userId;
    patch.reviewed_at = now;
  }
  return patch;
}

/**
 * The label for the plain-save button.
 *
 * Exported so the honesty of the label is a test, not a convention: on an
 * approved row this write publishes immediately, and calling it "Save draft"
 * is what made the critical bug above invisible to the person clicking it.
 */
export function saveButtonLabel(currentStatus: 'draft' | 'approved'): string {
  return currentStatus === 'approved' ? 'Save and keep live' : 'Save draft';
}
