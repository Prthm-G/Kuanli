'use client';

// ============================================================
// AddMemberDialog + LoginCredentials
//
// Add member: name + username + role → POST /api/account/members.
// The server returns a one-time password, shown here ONCE. The admin
// copies it or sends it on WhatsApp; the member signs in with it and
// picks their own password. Re-adding a removed member's username
// brings their old login back.
//
// LoginCredentials is the "send this to them" panel, shared with the
// Reset password flow in the Members tab.
//
// Counsellor (R2, Option 1): the dialog also asks for Branch and
// WhatsApp number, and once the login exists calls add_counsellor for
// the lead rotation entry. That entry stays inactive until they join
// the Telegram leads bot, so the join link is shown here, once.
// ============================================================

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Loader2, MessageCircle, Sparkles } from 'lucide-react';

import { Button, buttonVariants } from '@/components/ui/button';
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
import { roleLabel } from './role-meta';

type MemberRole = 'admin' | 'agent' | 'viewer';

const ROLE_DESCRIPTIONS: Record<MemberRole, string> = {
  admin: 'Can add teammates, manage settings, send messages, and edit data.',
  agent: 'Can use every feature (inbox, contacts, broadcasts) but not settings.',
  viewer: 'Read-only access across the app.',
};

export interface IssuedCredentials {
  login: string;
  password: string;
}

function credentialsMessage(c: IssuedCredentials): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return [
    'Your Kuanli login',
    `Username: ${c.login}`,
    `One-time password: ${c.password}`,
    `Sign in at ${origin}/login and choose your own password.`,
  ].join('\n');
}

export function LoginCredentials({ credentials }: { credentials: IssuedCredentials }) {
  const message = credentialsMessage(credentials);

  async function copy() {
    try {
      await navigator.clipboard.writeText(message);
      toast.success('Copied');
    } catch {
      toast.error('Copy failed. Select the text and copy it by hand.');
    }
  }

  return (
    <div className="space-y-3 py-2">
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 rounded-md border border-border bg-muted px-3 py-2 text-sm">
        <dt className="text-muted-foreground">Username</dt>
        <dd className="font-mono text-foreground">{credentials.login}</dd>
        <dt className="text-muted-foreground">One-time password</dt>
        <dd className="font-mono text-base tracking-wider text-foreground select-all">
          {credentials.password}
        </dd>
      </dl>

      <div className="rounded-md border border-amber-500/50 bg-amber-500/15 px-3 py-2 text-xs text-amber-200">
        <strong className="font-semibold text-amber-100">Send it now.</strong>{' '}
        This password is shown only once. If it&apos;s lost, use Reset password
        to issue a new one.
      </div>

      <div className="flex gap-2">
        <Button
          type="button"
          onClick={copy}
          className="flex-1 bg-primary hover:bg-primary/90 text-primary-foreground"
        >
          <Copy className="size-4" />
          Copy message
        </Button>
        <a
          href={`https://wa.me/?text=${encodeURIComponent(message)}`}
          target="_blank"
          rel="noreferrer noopener"
          className={buttonVariants({
            variant: 'outline',
            className: 'flex-1 border-border text-muted-foreground hover:bg-muted',
          })}
        >
          <MessageCircle className="size-4" />
          Send via WhatsApp
        </a>
      </div>
    </div>
  );
}

interface Branch {
  id: string;
  code: string;
  name: string;
}

/** What happened to the rotation entry after the login was made. */
type CounsellorOutcome =
  | { kind: 'code'; code: string }
  | { kind: 'linked' }
  | { kind: 'error'; error: string };

// Public on purpose: the bot's username is in every join link. Next inlines
// NEXT_PUBLIC_* at build time, so the image must be built with it set.
const LEADS_BOT = process.env.NEXT_PUBLIC_TELEGRAM_LEADS_BOT;

function CounsellorJoin({ outcome }: { outcome: CounsellorOutcome }) {
  if (outcome.kind === 'linked') {
    return (
      <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground">
        Linked to their existing rotation entry. Its branch, Telegram join and
        Takes leads setting are kept.
      </p>
    );
  }
  if (outcome.kind === 'error') {
    return (
      <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
        <strong className="font-semibold">The login was created</strong>, but
        they were not added to the lead rotation: {outcome.error}
      </div>
    );
  }
  const link = telegramJoinLink(LEADS_BOT, outcome.code);
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted px-3 py-2 text-sm">
      <p className="text-foreground">
        <strong className="font-semibold">Telegram join.</strong> They get no
        leads until they join the leads bot. Send them this, then turn on
        Takes leads in the Members list.
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
          <span className="font-mono text-foreground select-all">
            /start {outcome.code}
          </span>
        </p>
      )}
      <p className="text-xs text-muted-foreground">Shown only once.</p>
    </div>
  );
}

interface AddMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful add so the parent reloads the roster. */
  onCreated: () => void;
}

export function AddMemberDialog({ open, onOpenChange, onCreated }: AddMemberDialogProps) {
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<MemberRole>('agent');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    (IssuedCredentials & { restored: boolean; counsellor: CounsellorOutcome | null }) | null
  >(null);

  // Counsellor only: their lead rotation entry.
  const [branches, setBranches] = useState<Branch[]>([]);
  const [chosenBranch, setBranchId] = useState<string | null>(null);
  const [waNumber, setWaNumber] = useState('');
  const [editedDisplayName, setDisplayName] = useState<string | null>(null);
  const isCounsellor = role === 'agent';
  // One branch needs no choice.
  const branchId = chosenBranch ?? (branches.length === 1 ? branches[0].id : null);
  const displayName = editedDisplayName ?? defaultDisplayName(fullName);
  const waValid = normalizeWaNumber(waNumber) !== null;
  const displayNameValid = isValidDisplayName(displayName.trim());
  const counsellorReady = !isCounsellor || (!!branchId && waValid && displayNameValid);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void createClient()
      .from('branches')
      .select('id, code, name')
      .order('code')
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error('[AddMemberDialog] branches load error:', error);
          toast.error('Could not load branches');
          return;
        }
        setBranches((data ?? []) as Branch[]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  function reset() {
    setFullName('');
    setUsername('');
    setRole('agent');
    setSubmitting(false);
    setResult(null);
    setBranchId(null);
    setWaNumber('');
    setDisplayName(null);
  }

  async function addToRotation(profileId: unknown): Promise<CounsellorOutcome> {
    if (typeof profileId !== 'string' || !branchId) {
      return { kind: 'error', error: 'Kuanli could not find the new profile. Add them with the staff script.' };
    }
    const out = await addCounsellor(createClient(), {
      profileId,
      branchId,
      waNumber,
      displayName,
    });
    if (!out.ok) return { kind: 'error', error: out.error };
    if (out.linked || !out.startCode) return { kind: 'linked' };
    return { kind: 'code', code: out.startCode };
  }

  async function handleCreate() {
    setSubmitting(true);
    try {
      const res = await fetch('/api/account/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName, username, role }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || 'Failed to add member');
        return;
      }
      // The login exists from here on, whatever the rotation step does.
      let counsellor: CounsellorOutcome | null = null;
      if (isCounsellor) {
        try {
          counsellor = await addToRotation(payload.profileId);
        } catch (err) {
          console.error('[AddMemberDialog] add_counsellor error:', err);
          counsellor = { kind: 'error', error: 'Could not reach the server' };
        }
        if (counsellor.kind === 'error') {
          toast.error('Login created, but not added to the lead rotation');
        }
      }
      setResult({
        login: payload.login,
        password: payload.password,
        restored: payload.restored === true,
        counsellor,
      });
      onCreated();
    } catch (err) {
      console.error('[AddMemberDialog] create error:', err);
      toast.error('Could not reach the server');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // The one-time password is never kept across opens.
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="bg-popover border-border sm:max-w-md">
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-popover-foreground">
                <Sparkles className="size-4 text-primary" />
                {result.restored ? 'Member re-added' : 'Member added'}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {result.restored
                  ? 'This username belonged to a removed member. Their old login is back, with a new one-time password.'
                  : 'Send these details to your teammate. They choose their own password the first time they sign in.'}
              </DialogDescription>
            </DialogHeader>
            <LoginCredentials credentials={result} />
            {result.counsellor && <CounsellorJoin outcome={result.counsellor} />}
            <DialogFooter className="bg-popover border-border">
              <Button
                onClick={() => onOpenChange(false)}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">Add a member</DialogTitle>
              <DialogDescription className="text-muted-foreground">
                Pick a username. Kuanli gives you a one-time password to send
                them. No email needed.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="member-name" className="text-muted-foreground">
                  Name
                </Label>
                <Input
                  id="member-name"
                  placeholder="e.g. Simran"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  maxLength={80}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="member-username" className="text-muted-foreground">
                  Username
                </Label>
                <Input
                  id="member-username"
                  placeholder="e.g. simran"
                  value={username}
                  onChange={(e) => setUsername(e.target.value.toLowerCase())}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={32}
                  className="bg-muted border-border text-foreground font-mono placeholder:text-muted-foreground"
                />
                <p className="text-xs text-muted-foreground">
                  3-32 characters: letters, numbers, dot, dash or underscore.
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">Role</Label>
                <Select value={role} onValueChange={(v) => v && setRole(v as MemberRole)}>
                  <SelectTrigger className="w-full bg-muted border-border text-foreground">
                    <SelectValue>{roleLabel}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="agent">Counsellor</SelectItem>
                    <SelectItem value="viewer">Viewer</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{ROLE_DESCRIPTIONS[role]}</p>
              </div>

              {isCounsellor && (
                <>
                  <div className="space-y-2">
                    <Label className="text-muted-foreground">Branch</Label>
                    <Select value={branchId} onValueChange={(v) => setBranchId(v)}>
                      <SelectTrigger className="w-full bg-muted border-border text-foreground">
                        <SelectValue placeholder="Pick a branch" />
                      </SelectTrigger>
                      <SelectContent>
                        {branches.map((b) => (
                          <SelectItem key={b.id} value={b.id}>
                            {b.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="member-wa" className="text-muted-foreground">
                      WhatsApp number
                    </Label>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">+91</span>
                      <Input
                        id="member-wa"
                        inputMode="numeric"
                        placeholder="10 digits"
                        value={waNumber}
                        onChange={(e) => setWaNumber(e.target.value)}
                        maxLength={16}
                        className="bg-muted border-border text-foreground font-mono placeholder:text-muted-foreground"
                      />
                    </div>
                    {waNumber.trim() && !waValid && (
                      <p className="text-xs text-red-400">Enter a 10-digit Indian mobile number.</p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="member-display" className="text-muted-foreground">
                      Name in lead pings
                    </Label>
                    <Input
                      id="member-display"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      maxLength={12}
                      className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                    />
                    <p className={`text-xs ${displayName && !displayNameValid ? 'text-red-400' : 'text-muted-foreground'}`}>
                      Up to 12 letters, starting with a letter. Spaces and dots are fine.
                    </p>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    They join the lead rotation switched off. It turns on once
                    they join the Telegram leads bot and you switch on Takes
                    leads.
                  </p>
                </>
              )}
            </div>

            <DialogFooter className="bg-popover border-border">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                Cancel
              </Button>
              <Button
                onClick={handleCreate}
                disabled={
                  submitting || !fullName.trim() || !username.trim() || !counsellorReady
                }
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Adding...
                  </>
                ) : (
                  'Add member'
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
