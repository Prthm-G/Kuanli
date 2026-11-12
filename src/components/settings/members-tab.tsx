'use client';

// ============================================================
// MembersTab — Settings → Members
//
// Roster of every member of the account. Admin+ can add a member by
// username (one-time password), change a teammate's role inline,
// reset their password (new one-time password) and remove them. Owner
// row is non-editable everywhere (transfer is its own separate flow).
//
// Role-gating
//   The tab itself is reachable by any member, but mutation buttons
//   are wrapped in `<RequireRole min="admin">` / `useCan` so an
//   agent or viewer sees the roster read-only. The server-side
//   RPCs (set_member_role, remove_account_member) double-check
//   the role anyway.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  KeyRound,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react';

import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarImage,
} from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RequireRole } from '@/components/auth/require-role';
import { useAuth } from '@/hooks/use-auth';
import { usePresence } from '@/hooks/use-presence';
import type { AccountRole } from '@/lib/auth/roles';
import { presenceLabel, summarize } from '@/lib/presence';
import {
  PRESENCE_DOT_CLASS,
  PresenceDot,
} from '@/components/presence/presence-dot';
import {
  AddMemberDialog,
  LoginCredentials,
  type IssuedCredentials,
} from './add-member-dialog';
import { SettingsPanelHead } from './settings-panel-head';
import { ROLE_META } from './role-meta';

interface Member {
  user_id: string;
  full_name: string;
  username: string | null;
  email: string | null;
  avatar_url: string | null;
  role: AccountRole;
  joined_at: string;
}

// Editable roles in the inline dropdown. Owner is never an option —
// promotions go through the (deferred) Transfer Ownership flow.
const EDITABLE_ROLES: { value: AccountRole; label: string; hint: string }[] = [
  { value: 'admin', label: 'Admin', hint: 'Manage members + everything' },
  { value: 'agent', label: 'Counsellor', hint: 'Use features; no settings' },
  { value: 'viewer', label: 'Viewer', hint: 'Read-only across the app' },
];

// Per-role chip metadata (icon / label / colour) lives in the shared
// ROLE_META module so this roster and the Overview identity chip can't
// drift. The colour scale runs amber (owner — scarce, immutable) →
// primary (admin) → muted (agent / viewer).

function fmtDate(iso: string): string {
  // Match the rest of the dashboard's locale-light formatting.
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function MembersTab() {
  const { user, canManageMembers } = useAuth();
  const { getPresence, getRow, now } = usePresence();

  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);

  const [addOpen, setAddOpen] = useState(false);
  const [removingMember, setRemovingMember] = useState<Member | null>(null);
  const [resettingMember, setResettingMember] = useState<Member | null>(null);
  const [resetResult, setResetResult] = useState<IssuedCredentials | null>(null);
  const [pendingMemberAction, setPendingMemberAction] = useState<string | null>(
    null,
  );

  const loadEverything = useCallback(async () => {
    try {
      const mres = await fetch('/api/account/members', { cache: 'no-store' });

      if (!mres.ok) {
        const payload = await mres.json().catch(() => ({}));
        toast.error(payload.error || 'Failed to load members');
        return;
      }
      const mdata = (await mres.json()) as { members: Member[] };
      setMembers(mdata.members);
    } catch (err) {
      console.error('[MembersTab] load error:', err);
      toast.error('Could not reach the server');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadEverything();
  }, [loadEverything]);

  async function handleRoleChange(member: Member, nextRole: AccountRole) {
    if (member.role === nextRole) return;
    // Optimistic update — flip the dropdown immediately so the UI
    // feels snappy. If the server PATCH fails we revert below so
    // the dropdown doesn't lie about the persisted state.
    const previousRole = member.role;
    setPendingMemberAction(member.user_id);
    setMembers((prev) =>
      prev.map((m) =>
        m.user_id === member.user_id ? { ...m, role: nextRole } : m,
      ),
    );
    try {
      const res = await fetch(`/api/account/members/${member.user_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: nextRole }),
      });
      if (!res.ok) {
        // Revert the optimistic flip. The toast on its own wasn't
        // enough — the dropdown was left showing the new role
        // forever, so the next interaction operated on a wrong
        // baseline (re-trying the same change would no-op via the
        // `member.role === nextRole` guard at the top).
        setMembers((prev) =>
          prev.map((m) =>
            m.user_id === member.user_id ? { ...m, role: previousRole } : m,
          ),
        );
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Failed to update role');
        return;
      }
      toast.success(`Updated ${member.full_name || 'member'} to ${nextRole}`);
    } catch (err) {
      // Same revert on network failure.
      setMembers((prev) =>
        prev.map((m) =>
          m.user_id === member.user_id ? { ...m, role: previousRole } : m,
        ),
      );
      console.error('[MembersTab] role change error:', err);
      toast.error('Could not reach the server');
    } finally {
      setPendingMemberAction(null);
    }
  }

  async function handleRemove() {
    if (!removingMember) return;
    setPendingMemberAction(removingMember.user_id);
    try {
      const res = await fetch(
        `/api/account/members/${removingMember.user_id}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Failed to remove member');
        return;
      }
      toast.success(`Removed ${removingMember.full_name || 'member'}`);
      setMembers((prev) =>
        prev.filter((m) => m.user_id !== removingMember.user_id),
      );
      setRemovingMember(null);
    } catch (err) {
      console.error('[MembersTab] remove error:', err);
      toast.error('Could not reach the server');
    } finally {
      setPendingMemberAction(null);
    }
  }

  async function handleReset() {
    if (!resettingMember) return;
    setPendingMemberAction(resettingMember.user_id);
    try {
      const res = await fetch(
        `/api/account/members/${resettingMember.user_id}/reset-password`,
        { method: 'POST' },
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || 'Failed to reset password');
        return;
      }
      setResettingMember(null);
      setResetResult({ login: payload.login, password: payload.password });
    } catch (err) {
      console.error('[MembersTab] reset error:', err);
      toast.error('Could not reach the server');
    } finally {
      setPendingMemberAction(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title="Team members"
        description="People with access to this account. Roles control what each teammate can do."
        action={
          <RequireRole min="admin">
            <Button onClick={() => setAddOpen(true)}>
              <Plus className="size-4" />
              Add member
            </Button>
          </RequireRole>
        }
      />

      {/* Live presence summary across the roster. Updates without a
          full refresh as heartbeats and the local re-derive tick land. */}
      {members.length > 0 &&
        (() => {
          const counts = summarize(members.map((m) => getPresence(m.user_id)));
          return (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <PresenceDot status="online" />
                {counts.online} online
              </span>
              <span className="inline-flex items-center gap-1.5">
                <PresenceDot status="away" />
                {counts.away} away
              </span>
              <span className="inline-flex items-center gap-1.5">
                <PresenceDot status="offline" />
                {counts.offline} offline
              </span>
              <span className="text-muted-foreground/70">
                · {members.length} member{members.length === 1 ? '' : 's'}
              </span>
            </div>
          );
        })()}

      {/* Roster */}
      <Card>
        <CardContent className="p-0">
          <ul className="divide-y divide-border">
            {members.map((member) => {
              const roleMeta = ROLE_META[member.role];
              const RoleIcon = roleMeta.icon;
              const isSelf = member.user_id === user?.id;
              const isOwnerRow = member.role === 'owner';
              const isBusy = pendingMemberAction === member.user_id;
              const presence = getPresence(member.user_id);
              const presenceRow = getRow(member.user_id);
              const presenceText = presenceLabel(
                presence,
                presenceRow?.last_seen_at ?? null,
                now,
              );

              return (
                <li
                  key={member.user_id}
                  // Mobile: stack identity (avatar+name+email) above the
                  // role/remove actions so the role dropdown's fixed
                  // 128px width doesn't force the name into a 50-pixel
                  // truncation. Desktop (sm+): everything inline as
                  // before.
                  className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-4">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Avatar className="size-9 shrink-0">
                            {member.avatar_url ? (
                              <AvatarImage
                                src={member.avatar_url}
                                alt={member.full_name || 'Member'}
                              />
                            ) : null}
                            <AvatarFallback className="bg-primary/10 text-sm font-medium text-primary">
                              {(member.full_name || member.username || 'U')
                                .charAt(0)
                                .toUpperCase()}
                            </AvatarFallback>
                            {/* role+label so screen readers announce
                                presence — the hover tooltip alone isn't
                                reachable by keyboard/AT on a non-focusable
                                avatar. */}
                            <AvatarBadge
                              role="img"
                              aria-label={presenceText}
                              className={PRESENCE_DOT_CLASS[presence]}
                            />
                          </Avatar>
                        }
                      />
                      <TooltipContent>{presenceText}</TooltipContent>
                    </Tooltip>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {member.full_name || 'Unnamed'}
                        </span>
                        {isSelf && (
                          <Badge className="bg-muted text-muted-foreground border-border text-[10px] uppercase tracking-wide">
                            You
                          </Badge>
                        )}
                      </div>
                      {(member.username || member.email) && (
                        <p className="truncate text-xs text-muted-foreground">
                          {member.username ? `@${member.username}` : member.email}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Joined date stays desktop-only. The mobile row's
                      vertical density makes the joined date noise. */}
                  <div className="hidden sm:block text-right text-xs text-muted-foreground">
                    Joined {fmtDate(member.joined_at)}
                  </div>

                  {/* Actions cluster. On mobile this is its own row
                      below the identity block; on desktop it sits
                      inline. Items align to the start on mobile so the
                      role dropdown lines up under the avatar. */}
                  <div className="flex items-center gap-2 sm:gap-3">
                    {/* Role display / editor. Inline Select is admin+
                        only AND not allowed on the owner row (owner
                        changes go through transfer, which lands later). */}
                    {canManageMembers && !isOwnerRow && !isSelf ? (
                      <Select
                        value={member.role}
                        onValueChange={(v) =>
                          // Base UI Select can emit null on clear. We
                          // don't expose a clear affordance, so the
                          // guard is defensive — but the typed
                          // signature requires it.
                          v && handleRoleChange(member, v as AccountRole)
                        }
                      >
                        <SelectTrigger
                          className="w-32 bg-muted border-border text-foreground"
                          disabled={isBusy}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {EDITABLE_ROLES.map((r) => (
                            <SelectItem key={r.value} value={r.value}>
                              {r.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium ${roleMeta.className}`}
                      >
                        <RoleIcon className="size-3.5" />
                        {roleMeta.label}
                      </span>
                    )}

                    {/* Remove. Admin+ only; never on the owner row;
                        never on yourself. Pre-polish styling was
                        neutral-default + red-on-hover — the
                        destructive intent was invisible until the
                        user moused over. Now red is the default
                        state with a darker shade on hover so the
                        affordance reads at-a-glance. */}
                    {/* Reset password: a new one-time password. Same
                        visibility rules as Remove. */}
                    {canManageMembers && !isOwnerRow && !isSelf && (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="outline"
                              size="sm"
                              aria-label="Reset password"
                              onClick={() => setResettingMember(member)}
                              disabled={isBusy}
                            >
                              <KeyRound className="size-4" />
                            </Button>
                          }
                        />
                        <TooltipContent>Reset password</TooltipContent>
                      </Tooltip>
                    )}

                    {canManageMembers && !isOwnerRow && !isSelf && (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label="Remove member"
                        onClick={() => setRemovingMember(member)}
                        disabled={isBusy}
                        className="border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20 hover:border-red-500/60 hover:text-red-200"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <AddMemberDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={loadEverything}
      />

      <Dialog
        open={resettingMember !== null}
        onOpenChange={(open) => {
          if (!open) setResettingMember(null);
        }}
      >
        <DialogContent className="bg-popover border-border sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-popover-foreground">
              <KeyRound className="size-4 text-primary" />
              Reset password
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Give{' '}
              <span className="font-medium text-muted-foreground">
                {resettingMember?.full_name || 'this teammate'}
              </span>{' '}
              a new one-time password? Their current password stops working
              and they&apos;re signed out right away.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setResettingMember(null)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              Cancel
            </Button>
            <Button
              onClick={handleReset}
              disabled={!!pendingMemberAction}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {pendingMemberAction ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Resetting...
                </>
              ) : (
                'Reset password'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={resetResult !== null}
        onOpenChange={(open) => {
          // The one-time password is never kept once this closes.
          if (!open) setResetResult(null);
        }}
      >
        <DialogContent className="bg-popover border-border sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              New one-time password
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Send these details to your teammate. They choose a new password
              when they sign in.
            </DialogDescription>
          </DialogHeader>
          {resetResult && <LoginCredentials credentials={resetResult} />}
          <DialogFooter className="bg-popover border-border">
            <Button
              onClick={() => setResetResult(null)}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={removingMember !== null}
        onOpenChange={(open) => {
          if (!open) setRemovingMember(null);
        }}
      >
        <DialogContent className="bg-popover border-border sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-popover-foreground">
              <AlertTriangle className="size-4 text-amber-400" />
              Remove member
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Remove{' '}
              <span className="font-medium text-muted-foreground">
                {removingMember?.full_name || 'this teammate'}
              </span>{' '}
              from the account? They&apos;ll be signed out immediately and can&apos;t sign back in. To bring them back later, use Add member with the same username.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setRemovingMember(null)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              Cancel
            </Button>
            <Button
              onClick={handleRemove}
              disabled={!!pendingMemberAction}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {pendingMemberAction ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Removing...
                </>
              ) : (
                'Remove member'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
