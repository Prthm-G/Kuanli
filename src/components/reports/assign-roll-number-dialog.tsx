'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ENROLLMENT_UNIVERSITIES,
  defaultIntake,
  toEnrollmentCode,
} from '@/lib/reports/university-code';
import type { EodRow } from '@/lib/reports/types';

interface Props {
  row: EodRow | null;
  onClose: () => void;
  onDone: () => void;
}

/**
 * Confirm-then-generate for a lead's roll number.
 *
 * The university is pre-selected from what the bot inferred during the
 * conversation, translated through toEnrollmentCode because the two
 * vocabularies differ. It is a *pre-fill*, not an auto-submit: the roll number
 * is a permanent identifier spliced together by a DB trigger, and the bot's
 * inference is a guess off free text. The agent sees it before it sticks.
 *
 * When the bot's value has no enrollment equivalent nothing is pre-selected
 * and the agent must choose, rather than the dialog guessing.
 */
export function AssignRollNumberDialog({ row, onClose, onDone }: Props) {
  // State is seeded straight from props rather than synced in an effect. The
  // parent keys this component on the row id, so opening a different lead
  // remounts it and these initialisers run again — React's documented way to
  // reset state on prop change, and it avoids the cascading render an effect
  // would cause here.
  const intake = defaultIntake();
  const [university, setUniversity] = useState(
    () => toEnrollmentCode(row?.university) ?? ''
  );
  const [year, setYear] = useState(intake.year);
  const [session, setSession] = useState(intake.session);
  const [saving, setSaving] = useState(false);

  const unmatched =
    !!row?.university && toEnrollmentCode(row.university) === null;

  async function handleGenerate() {
    if (!row?.contactId || !university) return;
    setSaving(true);
    const { error } = await createClient().rpc('update_contact_enrollment', {
      p_contact_id: row.contactId,
      p_university: university,
      p_intake_year: year,
      p_intake_session: session,
    });
    setSaving(false);
    if (error) {
      toast.error(`Could not generate: ${error.message}`);
      return;
    }
    toast.success('Roll number generated');
    onDone();
    onClose();
  }

  const selectCls =
    'w-full rounded border border-border bg-background p-2 text-sm text-foreground';

  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Assign roll number</DialogTitle>
          <DialogDescription>
            {row?.name || row?.phone || 'This lead'} will get a permanent id.
            Check the university before generating.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="rn-university">University</Label>
            <select
              id="rn-university"
              value={university}
              onChange={(e) => setUniversity(e.target.value)}
              className={selectCls}
            >
              <option value="">Select a university…</option>
              {ENROLLMENT_UNIVERSITIES.map((u) => (
                <option key={u.code} value={u.code}>
                  {u.label}
                </option>
              ))}
            </select>
            {row?.university && !unmatched && (
              <p className="text-muted-foreground text-xs">
                Matched from the conversation: {row.university}
              </p>
            )}
            {unmatched && (
              <p className="text-xs text-amber-500">
                The bot recorded &ldquo;{row?.university}&rdquo;, which has no
                enrollment code. Choose one.
              </p>
            )}
            {!row?.university && (
              <p className="text-muted-foreground text-xs">
                No university was resolved in this conversation.
              </p>
            )}
          </div>

          <div className="flex gap-3">
            <div className="flex w-1/2 flex-col gap-2">
              <Label htmlFor="rn-year">Intake year</Label>
              <select
                id="rn-year"
                value={year}
                onChange={(e) => setYear(e.target.value)}
                className={selectCls}
              >
                <option value="26">2026</option>
                <option value="27">2027</option>
              </select>
            </div>
            <div className="flex w-1/2 flex-col gap-2">
              <Label htmlFor="rn-session">Intake session</Label>
              <select
                id="rn-session"
                value={session}
                onChange={(e) => setSession(e.target.value)}
                className={selectCls}
              >
                <option value="J">July Intake (J)</option>
                <option value="A">August Intake (A)</option>
              </select>
            </div>
          </div>

          <p className="border-border bg-muted/40 rounded border px-3 py-2 font-mono text-sm">
            {university ? `D${university}${year}${session}####` : 'D…'}
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleGenerate} disabled={!university || saving}>
            {saving ? 'Generating…' : 'Generate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
