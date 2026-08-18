"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import {
  ENROLLMENT_UNIVERSITIES,
  defaultIntake,
  toEnrollmentCode,
} from "@/lib/reports/university-code";
import type { Contact } from "@/types";

interface Props {
  contact: Contact;
  /** What the bot worked out during the conversation, if anything. */
  interestUniversity?: string | null;
  onDone?: () => void;
}

/**
 * Issue a contact's DCId (roll number).
 *
 * Split out of ContactSidebar so it can be keyed on the conversation: the form
 * must re-seed when the agent switches threads, and keying a small component is
 * how React resets state on prop change. Syncing it inside the sidebar would
 * have meant an effect writing state on every render, and the sidebar's notes,
 * deals and tags must NOT reset when the thread changes.
 *
 * The university is pre-filled from the bot's inference, translated through
 * toEnrollmentCode because the two vocabularies differ: the bot says "Amity",
 * the generator needs "AMI", and generate_roll_number() splices the value
 * straight into a permanent id. It is a suggestion, never an auto-submit.
 */
export function EnrollmentPanel({ contact, interestUniversity, onDone }: Props) {
  const suggested = toEnrollmentCode(interestUniversity);
  const intake = defaultIntake();
  const [university, setUniversity] = useState(suggested ?? "");
  const [year, setYear] = useState(intake.year);
  const [session, setSession] = useState(intake.session);
  const [saving, setSaving] = useState(false);

  const handleGenerate = useCallback(async () => {
    if (!university) return;
    setSaving(true);
    const { error } = await createClient().rpc("update_contact_enrollment", {
      p_contact_id: contact.id,
      p_university: university,
      p_intake_year: year,
      p_intake_session: session,
    });
    setSaving(false);
    if (error) {
      toast.error(`Could not generate DCId: ${error.message}`);
      return;
    }
    toast.success("DCId generated");
    onDone?.();
  }, [contact.id, university, year, session, onDone]);

  const sel = "rounded border border-border bg-background p-1.5 text-sm";

  return (
    <div className="mt-2 space-y-2 rounded-lg bg-muted p-3">
      <select
        aria-label="University"
        value={university}
        onChange={(e) => setUniversity(e.target.value)}
        className={`w-full ${sel}`}
      >
        <option value="">Select a university…</option>
        {ENROLLMENT_UNIVERSITIES.map((u) => (
          <option key={u.code} value={u.code}>
            {u.label}
          </option>
        ))}
      </select>

      {interestUniversity && (
        <p className="text-xs text-muted-foreground">
          {suggested
            ? `Matched from the conversation: ${interestUniversity}`
            : `The bot recorded “${interestUniversity}”, which has no enrollment code. Choose one.`}
        </p>
      )}

      <div className="flex gap-2">
        <select
          aria-label="Intake year"
          value={year}
          onChange={(e) => setYear(e.target.value)}
          className={`w-1/2 ${sel}`}
        >
          <option value="26">2026</option>
          <option value="27">2027</option>
        </select>
        <select
          aria-label="Intake session"
          value={session}
          onChange={(e) => setSession(e.target.value)}
          className={`w-1/2 ${sel}`}
        >
          <option value="J">July Intake (J)</option>
          <option value="A">August Intake (A)</option>
        </select>
      </div>

      <p className="rounded bg-background/60 px-2 py-1 font-mono text-xs text-muted-foreground">
        {university ? `D${university}${year}${session}####` : "D…"}
      </p>

      <button
        onClick={handleGenerate}
        disabled={!university || saving}
        className="mt-2 w-full rounded bg-primary py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
      >
        {saving ? "Generating…" : "Generate DCId"}
      </button>
    </div>
  );
}
