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
// ============================================================

import { useState } from 'react';
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
  const [result, setResult] = useState<(IssuedCredentials & { restored: boolean }) | null>(null);

  function reset() {
    setFullName('');
    setUsername('');
    setRole('agent');
    setSubmitting(false);
    setResult(null);
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
      setResult({
        login: payload.login,
        password: payload.password,
        restored: payload.restored === true,
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
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="agent">Counsellor</SelectItem>
                    <SelectItem value="viewer">Viewer</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{ROLE_DESCRIPTIONS[role]}</p>
              </div>
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
                disabled={submitting || !fullName.trim() || !username.trim()}
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
