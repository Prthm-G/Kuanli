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
  saveContactEmail,
  type ApplicationRecord,
} from '@/lib/applications/application-queries';
import {
  GATE_LABELS,
  mergeServerFields,
  parseGateError,
  punchedGateMissing,
  type GateKey,
} from '@/lib/applications/panel-rules';

interface ApplicationPanelProps {
  contactId: string;
  accountId: string;
  /** The signed-in member: recorded on "punched" and "form filled by me". */
  userId: string;
  /** Agent or above. Viewers see the values and no buttons. */
  canEdit: boolean;
  /** The contact's email; it lives on the contact, not the application. */
  contactEmail?: string | null;
  /** The contact's university, shown until the application has its own. */
  contactUniversity?: string | null;
  /** Called after a save so the sidebar can re-read the stage: the database may have moved the card. */
  onSaved?: () => void;
}

interface Fields {
  fatherName: string;
  program: string;
  university: string;
  specialization: string;
  universityAppNumber: string;
  provisionalAppId: string;
  registrationNumber: string;
}

const UNIVERSITIES = ['LPU', 'Amity', 'CU', 'DBU'];

const EMPTY: Fields = {
  fatherName: '',
  program: '',
  university: '',
  specialization: '',
  universityAppNumber: '',
  provisionalAppId: '',
  registrationNumber: '',
};

const fieldsOf = (
  a: ApplicationRecord | null,
  contactUniversity?: string | null
): Fields =>
  a || contactUniversity
    ? {
        fatherName: a?.fatherName ?? '',
        program: a?.program ?? '',
        university: a?.university ?? contactUniversity ?? '',
        specialization: a?.specialization ?? '',
        universityAppNumber: a?.universityAppNumber ?? '',
        provisionalAppId: a?.provisionalAppId ?? '',
        registrationNumber: a?.registrationNumber ?? '',
      }
    : EMPTY;

const when = (iso: string | null) =>
  iso ? format(new Date(iso), 'MMM d, yyyy HH:mm') : '';

export function ApplicationPanel({
  contactId,
  accountId,
  userId,
  canEdit,
  contactEmail,
  contactUniversity,
  onSaved,
}: ApplicationPanelProps) {
  const [app, setApp] = useState<ApplicationRecord | null>(null);
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  /** null = untouched: the field shows the contact's email. */
  const [emailDraft, setEmailDraft] = useState<string | null>(null);
  /** Set once the counsellor presses the punched button: marks the fields it needs. */
  const [punchTried, setPunchTried] = useState(false);
  const email = emailDraft ?? contactEmail ?? '';
  const liveMissing = punchTried
    ? punchedGateMissing({ ...fields, email })
    : [];
  const emailChanged =
    emailDraft !== null &&
    emailDraft.trim().toLowerCase() !==
      (contactEmail ?? '').trim().toLowerCase();
  /** What the form last loaded from the server: a field that differs is unsaved typing. */
  const baseline = useRef<Fields>(EMPTY);

  // Every setter runs in a promise callback, so the effect below sets no
  // state synchronously.
  const load = useCallback(async () => {
    await loadApplication(createClient(), contactId)
      .then((a) => {
        const fresh = fieldsOf(a, contactUniversity);
        const base = baseline.current;
        baseline.current = fresh;
        setApp(a);
        // Unsaved typing survives a button's save and reload.
        setFields((cur) => mergeServerFields(cur, base, fresh));
        setLoaded(true);
      })
      .catch((e) => {
        console.error('Failed to load application:', e);
        toast.error('Could not load the application');
      });
  }, [contactId, contactUniversity]);

  useEffect(() => {
    void load();
  }, [load]);

  const gateMessage = (keys: GateKey[]) =>
    `Fill these first: ${keys.map((k) => GATE_LABELS[k]).join(', ')}`;

  /** Email goes to the contact first; if that fails the application is not saved. */
  const run = useCallback(
    async (
      save: Parameters<typeof saveApplication>[1] | null,
      okMessage: string,
      emailToSave?: string
    ) => {
      setBusy(true);
      let emailSaved = false;
      try {
        if (emailToSave !== undefined) {
          try {
            await saveContactEmail(createClient(), contactId, emailToSave);
          } catch (e) {
            console.error('Failed to save email:', e);
            toast.error('Could not save the email');
            return;
          }
          // The contact changed even if the application save below fails.
          onSaved?.();
          emailSaved = true;
        }
        if (save) await saveApplication(createClient(), save);
        toast.success(okMessage);
        await load();
        onSaved?.();
      } catch (e) {
        const code = (e as { code?: string }).code;
        const gate =
          code === 'P0001'
            ? parseGateError(String((e as { message?: string }).message ?? ''))
            : null;
        console.error('Failed to save application:', e);
        if (gate) setPunchTried(true);
        toast.error(
          gate
            ? gateMessage(gate)
            : code === '23505'
              ? 'That registration number is already used by another student'
              : emailSaved
                ? 'Email saved. Could not save the application'
                : 'Could not save the application'
        );
      } finally {
        setBusy(false);
      }
    },
    [contactId, load, onSaved]
  );

  // Only what the counsellor changed is sent, so a value the database filled
  // meanwhile (a provisional ID from a saved login) is not blanked by a stale form.
  // A university is only sent when filled and different from the stored one.
  const changedFields = (): Partial<Fields> => {
    const before = fieldsOf(app);
    const changed: Partial<Fields> = {};
    for (const k of Object.keys(fields) as Array<keyof Fields>) {
      if (fields[k].trim() !== before[k].trim()) changed[k] = fields[k];
    }
    if (changed.university !== undefined && changed.university.trim() === '') {
      delete changed.university;
    }
    return changed;
  };

  const handleSave = () => {
    const changed = changedFields();
    if (Object.keys(changed).length === 0 && !emailChanged) {
      toast.message('Nothing to save');
      return;
    }
    void run(
      Object.keys(changed).length > 0
        ? { accountId, contactId, ...changed }
        : null,
      'Application saved',
      emailChanged ? email : undefined
    );
  };

  const handlePunched = () => {
    const missing = punchedGateMissing({ ...fields, email });
    setPunchTried(true);
    if (missing.length > 0) {
      toast.error(gateMessage(missing));
      return;
    }
    void run(
      { accountId, contactId, ...changedFields(), detailsPunchedBy: userId },
      'Marked as punched on the portal',
      emailChanged ? email : undefined
    );
  };

  const set = (k: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFields((f) => ({ ...f, [k]: e.target.value }));

  const invalid = (key: GateKey) => liveMissing.includes(key);

  const text = (
    k: keyof Fields,
    label: string,
    opts: { gate?: GateKey; list?: string } = {}
  ) => (
    <div className="space-y-1">
      <Label htmlFor={`app-${k}-${contactId}`} className="text-xs">
        {label}
      </Label>
      <Input
        id={`app-${k}-${contactId}`}
        value={fields[k]}
        onChange={set(k)}
        disabled={!canEdit || busy || !loaded}
        list={opts.list}
        aria-invalid={opts.gate && invalid(opts.gate) ? true : undefined}
        className={`h-8 text-xs ${opts.gate && invalid(opts.gate) ? 'border-red-500' : ''}`}
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
      {text('fatherName', "Father's name", { gate: 'father_name' })}
      {text('program', 'Program', { gate: 'program' })}
      {text('university', 'University', {
        gate: 'university',
        list: `app-universities-${contactId}`,
      })}
      <datalist id={`app-universities-${contactId}`}>
        {[
          ...UNIVERSITIES,
          ...[app?.university, contactUniversity].filter(
            (u): u is string => !!u
          ),
        ]
          .filter((u, i, all) => all.indexOf(u) === i)
          .map((u) => (
            <option key={u} value={u} />
          ))}
      </datalist>
      {text('specialization', 'Specialization (optional)')}
      <div className="space-y-1">
        <Label htmlFor={`app-email-${contactId}`} className="text-xs">
          Email
        </Label>
        <Input
          id={`app-email-${contactId}`}
          type="email"
          value={email}
          onChange={(e) => setEmailDraft(e.target.value)}
          disabled={!canEdit || busy || !loaded}
          aria-invalid={invalid('email') ? true : undefined}
          className={`h-8 text-xs ${invalid('email') ? 'border-red-500' : ''}`}
        />
      </div>

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
            onClick={handlePunched}
          >
            Details punched on portal
          </Button>
        )}
      </div>

      {text('provisionalAppId', 'Provisional ID')}
      {text('universityAppNumber', 'University application no.')}

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
