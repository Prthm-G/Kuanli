'use client';

// ============================================================
// Lead rotation form (R2, Option 1): Branch, WhatsApp number and ping
// name for a counsellor's `counsellors` row, sent through
// add_counsellor. Shared by Add member (right after the login is
// made, with a retry step if it fails) and the Members list's "Add to
// rotation" for a Counsellor who has no entry yet.
//
// A new entry stays inactive until the counsellor joins the Telegram
// leads bot, so the join link is shown once, with copy buttons.
// ============================================================

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { createClient } from '@/lib/supabase/client';
import {
  addCounsellor,
  defaultDisplayName,
  isValidDisplayName,
  normalizeWaNumber,
  telegramJoinLink,
} from '@/lib/counsellors/counsellors';

export interface Branch {
  id: string;
  code: string;
  name: string;
}

/** What add_counsellor did. */
export type RotationOutcome =
  /** A join code to send. `linked`: an existing entry, not joined yet. */
  | { kind: 'code'; code: string; linked: boolean }
  /** An existing entry that has already joined Telegram. */
  | { kind: 'linked' }
  | { kind: 'error'; error: string };

// Public on purpose: the bot's username is in every join link. Next inlines
// NEXT_PUBLIC_* at build time, so the image must be built with it set.
const LEADS_BOT = process.env.NEXT_PUBLIC_TELEGRAM_LEADS_BOT;

/** Active branches, loaded while `open`. */
function useActiveBranches(open: boolean) {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    createClient()
      .from('branches')
      .select('id, code, name')
      .eq('active', true)
      .order('code')
      .then(
        ({ data, error }) => {
          if (cancelled) return;
          if (error) {
            console.error('[RotationForm] branches load error:', error);
            toast.error('Could not load branches');
          }
          setBranches((data ?? []) as Branch[]);
          setLoaded(true);
        },
        (err: unknown) => {
          console.error('[RotationForm] branches load error:', err);
          if (!cancelled) setLoaded(true);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [open]);
  return { branches, loaded };
}

/** Form state for one counsellor's rotation entry. */
export function useRotationForm(open: boolean, fullName: string) {
  const { branches, loaded } = useActiveBranches(open);
  const [chosenBranch, setBranchId] = useState<string | null>(null);
  const [waNumber, setWaNumber] = useState('');
  const [editedDisplayName, setDisplayName] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // One branch needs no choice; a branch no longer listed is no choice.
  const branchId =
    chosenBranch && branches.some((b) => b.id === chosenBranch)
      ? chosenBranch
      : branches.length === 1
        ? branches[0].id
        : null;
  const displayName = editedDisplayName ?? defaultDisplayName(fullName);
  const waValid = normalizeWaNumber(waNumber) !== null;
  const displayNameValid = isValidDisplayName(displayName.trim());
  const ready = !!branchId && waValid && displayNameValid;

  function reset() {
    setBranchId(null);
    setWaNumber('');
    setDisplayName(null);
    setSubmitting(false);
  }

  async function submit(profileId: string | null | undefined): Promise<RotationOutcome> {
    if (!profileId) {
      return {
        kind: 'error',
        error: 'Kuanli could not find their profile. Use Add to rotation in the Members list.',
      };
    }
    if (!branchId) return { kind: 'error', error: 'Pick a branch' };
    setSubmitting(true);
    try {
      const out = await addCounsellor(createClient(), {
        profileId,
        branchId,
        waNumber,
        displayName,
      });
      if (!out.ok) return { kind: 'error', error: out.error };
      if (out.startCode) return { kind: 'code', code: out.startCode, linked: out.linked };
      return { kind: 'linked' };
    } catch (err) {
      console.error('[RotationForm] add_counsellor error:', err);
      return { kind: 'error', error: 'Could not reach the server' };
    } finally {
      setSubmitting(false);
    }
  }

  return {
    branches,
    loaded,
    branchId,
    setBranchId,
    waNumber,
    setWaNumber,
    waValid,
    displayName,
    setDisplayName,
    displayNameValid,
    ready,
    submitting,
    reset,
    submit,
  };
}

export type RotationForm = ReturnType<typeof useRotationForm>;

export function RotationFields({ form, idPrefix }: { form: RotationForm; idPrefix: string }) {
  const branchLabelId = `${idPrefix}-branch-label`;
  return (
    <>
      <div className="space-y-2">
        <Label id={branchLabelId} className="text-muted-foreground">
          Branch
        </Label>
        <Select value={form.branchId} onValueChange={(v) => form.setBranchId(v)}>
          <SelectTrigger
            aria-labelledby={branchLabelId}
            className="w-full bg-muted border-border text-foreground"
          >
            <SelectValue placeholder="Pick a branch" />
          </SelectTrigger>
          <SelectContent>
            {form.branches.map((b) => (
              <SelectItem key={b.id} value={b.id}>
                {b.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {form.loaded && form.branches.length === 0 && (
          <p className="text-xs text-red-400">
            No branches yet. A branch must exist before a counsellor can take leads.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-wa`} className="text-muted-foreground">
          WhatsApp number
        </Label>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">+91</span>
          <Input
            id={`${idPrefix}-wa`}
            inputMode="numeric"
            placeholder="10 digits"
            value={form.waNumber}
            onChange={(e) => form.setWaNumber(e.target.value)}
            maxLength={16}
            className="bg-muted border-border text-foreground font-mono placeholder:text-muted-foreground"
          />
        </div>
        {form.waNumber.trim() && !form.waValid && (
          <p className="text-xs text-red-400">Enter a 10-digit Indian mobile number.</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-display`} className="text-muted-foreground">
          Name in lead pings
        </Label>
        <Input
          id={`${idPrefix}-display`}
          value={form.displayName}
          onChange={(e) => form.setDisplayName(e.target.value)}
          maxLength={12}
          className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
        />
        <p
          className={`text-xs ${form.displayName && !form.displayNameValid ? 'text-red-400' : 'text-muted-foreground'}`}
        >
          Up to 12 letters, starting with a letter. Spaces and dots are fine.
        </p>
      </div>
    </>
  );
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Copied');
  } catch {
    toast.error('Copy failed. Select the text and copy it by hand.');
  }
}

/** The result of a successful add_counsellor: a join code, or linked. */
export function RotationJoin({
  outcome,
}: {
  outcome: Exclude<RotationOutcome, { kind: 'error' }>;
}) {
  if (outcome.kind === 'linked') {
    return (
      <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground">
        Linked to their existing rotation entry; Telegram join kept.
      </p>
    );
  }
  const link = telegramJoinLink(LEADS_BOT, outcome.code);
  const startText = `/start ${outcome.code}`;
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted px-3 py-2 text-sm">
      <p className="text-foreground">
        <strong className="font-semibold">Telegram join.</strong>{' '}
        {outcome.linked
          ? 'Linked to their existing rotation entry, which has not joined Telegram yet.'
          : 'They get no leads until they join the leads bot.'}{' '}
        Send them this, then turn on Takes leads in the Members list.
      </p>
      {link ? (
        <a
          href={link}
          target="_blank"
          rel="noreferrer noopener"
          className="block break-all font-mono text-primary underline underline-offset-2"
        >
          {link}
        </a>
      ) : (
        <p className="text-muted-foreground">
          Open the Kuanli leads bot on Telegram (the same bot the other
          counsellors use) and send:{' '}
          <span className="font-mono text-foreground select-all">{startText}</span>
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {link && (
          <Button type="button" variant="outline" size="sm" onClick={() => void copy(link)}>
            <Copy className="size-3.5" />
            Copy link
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" onClick={() => void copy(startText)}>
          <Copy className="size-3.5" />
          Copy /start code
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Shown only once.</p>
    </div>
  );
}

/** True for the close reasons that should not drop a join code unseen. */
export function isStrayClose(reason: string): boolean {
  return reason === 'outside-press' || reason === 'escape-key';
}

/** Members list: add an existing Counsellor login to the rotation. */
export function AddToRotationDialog({
  member,
  onOpenChange,
  onAdded,
}: {
  /** Open while set. */
  member: { profile_id: string; full_name: string } | null;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}) {
  const open = member !== null;
  const form = useRotationForm(open, member?.full_name ?? '');
  const [outcome, setOutcome] = useState<RotationOutcome | null>(null);
  const done = outcome && outcome.kind !== 'error' ? outcome : null;

  function close() {
    form.reset();
    setOutcome(null);
    onOpenChange(false);
  }

  async function handleAdd() {
    if (!member) return;
    const out = await form.submit(member.profile_id);
    setOutcome(out);
    if (out.kind === 'error') toast.error(out.error);
    else onAdded();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (!next && done?.kind === 'code' && isStrayClose(details.reason)) {
          details.cancel();
          return;
        }
        if (!next) close();
        else onOpenChange(true);
      }}
    >
      <DialogContent className="bg-popover border-border sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">Add to rotation</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {member?.full_name || 'This counsellor'} gets leads once they join
            the Telegram leads bot and you turn on Takes leads.
          </DialogDescription>
        </DialogHeader>
        {done ? (
          <RotationJoin outcome={done} />
        ) : (
          <div className="space-y-4 py-2">
            {outcome?.kind === 'error' && (
              <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {outcome.error}
              </p>
            )}
            <RotationFields form={form} idPrefix="rotation-add" />
          </div>
        )}
        <DialogFooter className="bg-popover border-border">
          {done ? (
            <Button onClick={close}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button onClick={handleAdd} disabled={!form.ready || form.submitting}>
                {form.submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Adding...
                  </>
                ) : (
                  'Add to rotation'
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
