'use client';

// ============================================================
// ContactOwnerSelect: who owns this lead (migration 098), on the
// contact page. Admin and owner only; the parent hides it for
// everyone else. Lists members who can work leads plus "Unowned",
// and writes through set_contact_owner, which also moves the chats.
// The lead's branch shows beside it, read-only.
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { createClient } from '@/lib/supabase/client';
import { ownerCandidates, setContactOwner } from '@/lib/contacts/owner';
import type { AccountMember } from '@/types';

// Base UI needs a non-null item value; this one stands for owner_profile_id null.
const UNOWNED = '__unowned__';

interface ContactOwnerSelectProps {
  contactId: string;
  ownerProfileId: string | null;
  branchId: string | null;
  onChanged: (ownerProfileId: string | null) => void;
}

export function ContactOwnerSelect({
  contactId,
  ownerProfileId,
  branchId,
  onChanged,
}: ContactOwnerSelectProps) {
  const [members, setMembers] = useState<AccountMember[]>([]);
  const [membersLoaded, setMembersLoaded] = useState(false);
  // Keyed by id, so a stale name never shows against another branch.
  const [branch, setBranch] = useState<{ id: string; name: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/account/members', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((json: { members?: AccountMember[] }) => {
        if (!cancelled) setMembers(json.members ?? []);
      })
      .catch((err: unknown) => {
        console.error('[ContactOwnerSelect] members load error:', err);
        if (!cancelled) toast.error('Could not load members');
      })
      .finally(() => {
        if (!cancelled) setMembersLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!branchId) return;
    let cancelled = false;
    createClient()
      .from('branches')
      .select('name')
      .eq('id', branchId)
      .maybeSingle()
      .then(
        ({ data, error }) => {
          if (cancelled) return;
          // The branch label is a nicety: on error, log and show none.
          if (error) console.error('[ContactOwnerSelect] branch load error:', error);
          const name = (data as { name: string } | null)?.name;
          setBranch(name ? { id: branchId, name } : null);
        },
        (err: unknown) => console.error('[ContactOwnerSelect] branch load error:', err),
      );
    return () => {
      cancelled = true;
    };
  }, [branchId]);

  const options = useMemo(
    () =>
      ownerCandidates(
        members.flatMap((m) =>
          m.profile_id
            ? [{ ...m, profile_id: m.profile_id, full_name: m.full_name || 'Unnamed' }]
            : []
        ),
        ownerProfileId
      ),
    [members, ownerProfileId]
  );

  async function change(value: string | null) {
    const next = !value || value === UNOWNED ? null : value;
    if (next === ownerProfileId) return;
    setSaving(true);
    try {
      const out = await setContactOwner(createClient(), contactId, next);
      if (!out.ok) {
        toast.error(out.error);
        return;
      }
      toast.success(next ? 'Owner changed' : 'Lead is now unowned');
      onChanged(next);
    } catch (err) {
      console.error('[ContactOwnerSelect] set owner error:', err);
      toast.error('Could not reach the server');
    } finally {
      setSaving(false);
    }
  }

  const value = ownerProfileId ?? UNOWNED;
  const known = value === UNOWNED || options.some((o) => o.profile_id === value);

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">Owner</span>
      <Select value={value} onValueChange={(v) => void change(v)} disabled={saving}>
        <SelectTrigger
          size="sm"
          aria-label="Owner"
          className="bg-muted border-border text-foreground min-w-40"
        >
          {/* An owner id with no roster row has no label of its own. */}
          <SelectValue>
            {known ? undefined : () => (membersLoaded ? 'Unknown owner' : 'Loading...')}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNOWNED}>Unowned</SelectItem>
          {options.map((m) => (
            <SelectItem key={m.profile_id} value={m.profile_id}>
              {m.full_name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {branchId && branch?.id === branchId && (
        <span className="text-muted-foreground">
          Branch: <span className="text-foreground">{branch.name}</span>
        </span>
      )}
    </div>
  );
}
