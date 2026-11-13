'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { format } from 'date-fns';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createClient } from '@/lib/supabase/client';
import {
  loadApplication,
  saveApplication,
  type ApplicationRecord,
} from '@/lib/applications/application-queries';
import { mergeServerFields } from '@/lib/applications/panel-rules';

interface ApplicationPanelProps {
  contactId: string;
  accountId: string;
  /** The signed-in member: recorded on "punched" and "form filled by me". */
  userId: string;
  /** Agent or above. Viewers see the values and no buttons. */
  canEdit: boolean;
  /** Called after a save so the sidebar can re-read the stage: the database may have moved the card. */
  onSaved?: () => void;
}

interface Fields {
  fatherName: string;
  program: string;
  specialization: string;
  provisionalAppId: string;
  registrationNumber: string;
}

const EMPTY: Fields = {
  fatherName: '',
  program: '',
  specialization: '',
  provisionalAppId: '',
  registrationNumber: '',
};

const fieldsOf = (a: ApplicationRecord | null): Fields =>
  a
    ? {
        fatherName: a.fatherName ?? '',
        program: a.program ?? '',
        specialization: a.specialization ?? '',
        provisionalAppId: a.provisionalAppId ?? '',
        registrationNumber: a.registrationNumber ?? '',
      }
    : EMPTY;

const when = (iso: string | null) =>
  iso ? format(new Date(iso), 'MMM d, yyyy HH:mm') : '';

export function ApplicationPanel({
  contactId,
  accountId,
  userId,
  canEdit,
  onSaved,
}: ApplicationPanelProps) {
  const [app, setApp] = useState<ApplicationRecord | null>(null);
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  /** What the form last loaded from the server: a field that differs is unsaved typing. */
  const baseline = useRef<Fields>(EMPTY);

  const load = useCallback(async () => {
    try {
      const a = await loadApplication(createClient(), contactId);
      const fresh = fieldsOf(a);
      const base = baseline.current;
      baseline.current = fresh;
      setApp(a);
      // Unsaved typing survives a button's save and reload.
      setFields((cur) => mergeServerFields(cur, base, fresh));
      setLoaded(true);
    } catch (e) {
      console.error('Failed to load application:', e);
      toast.error('Could not load the application');
    }
  }, [contactId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (save: Parameters<typeof saveApplication>[1], okMessage: string) => {
      setBusy(true);
      try {
        await saveApplication(createClient(), save);
        toast.success(okMessage);
        await load();
        onSaved?.();
      } catch (e) {
        const code = (e as { code?: string }).code;
        console.error('Failed to save application:', e);
        toast.error(
          code === '23505'
            ? 'That registration number is already used by another student'
            : 'Could not save the application'
        );
      } finally {
        setBusy(false);
      }
    },
    [load, onSaved]
  );

  // Only what the counsellor changed is sent, so a value the database filled
  // meanwhile (a provisional ID from a saved login) is not blanked by a stale form.
  const handleSave = () => {
    const before = fieldsOf(app);
    const changed: Partial<Fields> = {};
    for (const k of Object.keys(fields) as Array<keyof Fields>) {
      if (fields[k].trim() !== before[k].trim()) changed[k] = fields[k];
    }
    if (Object.keys(changed).length === 0) {
      toast.message('Nothing to save');
      return;
    }
    void run({ accountId, contactId, ...changed }, 'Application saved');
  };

  const set = (k: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFields((f) => ({ ...f, [k]: e.target.value }));

  const text = (k: keyof Fields, label: string) => (
    <div className="space-y-1">
      <Label htmlFor={`app-${k}-${contactId}`} className="text-xs">
        {label}
      </Label>
      <Input
        id={`app-${k}-${contactId}`}
        value={fields[k]}
        onChange={set(k)}
        disabled={!canEdit || busy || !loaded}
        className="h-8 text-xs"
      />
    </div>
  );

  const formBy =
    app?.formFilledByKind === 'student'
      ? 'the student'
      : app?.formFilledByKind === 'staff'
        ? app.formFilledBy === userId
          ? 'you'
          : 'a counsellor'
        : null;

  return (
    <div className="space-y-2" aria-busy={busy || !loaded}>
      {text('fatherName', "Father's name")}
      {text('program', 'Program')}
      {text('specialization', 'Specialization')}

      <div className="bg-muted rounded-lg px-3 py-2">
        {app?.detailsPunchedAt ? (
          <p className="text-muted-foreground text-xs">
            Details punched on portal, {when(app.detailsPunchedAt)}
          </p>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            disabled={!canEdit || busy || !loaded}
            onClick={() =>
              void run(
                { accountId, contactId, detailsPunchedBy: userId },
                'Marked as punched on the portal'
              )
            }
          >
            Details punched on portal
          </Button>
        )}
      </div>

      {text('provisionalAppId', 'Provisional ID')}

      <div className="bg-muted space-y-2 rounded-lg px-3 py-2">
        <p className="text-muted-foreground text-xs">Form filled by</p>
        {formBy ? (
          <p className="text-foreground text-xs">
            {formBy}, {when(app?.formFilledAt ?? null)}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            disabled={!canEdit || busy || !loaded}
            onClick={() =>
              void run(
                {
                  accountId,
                  contactId,
                  formFilledBy: { kind: 'student', userId },
                },
                'Form marked as filled by the student'
              )
            }
          >
            Student
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            disabled={!canEdit || busy || !loaded}
            onClick={() =>
              void run(
                {
                  accountId,
                  contactId,
                  formFilledBy: { kind: 'staff', userId },
                },
                'Form marked as filled by you'
              )
            }
          >
            Me
          </Button>
        </div>
      </div>

      {text('registrationNumber', 'Registration number')}

      {canEdit && (
        <Button
          size="sm"
          className="w-full"
          disabled={busy || !loaded}
          onClick={handleSave}
        >
          Save application
        </Button>
      )}
    </div>
  );
}
