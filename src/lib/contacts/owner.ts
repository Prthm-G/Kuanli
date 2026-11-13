import type { SupabaseClient } from '@supabase/supabase-js';

import { hasMinRole, type AccountRole } from '@/lib/auth/roles';

/**
 * The owner of a lead (migration 098): `contacts.owner_profile_id`, a
 * profiles.id. A counsellor sees only the leads they own; the owner and admins
 * see all. Only admins change it, through `set_contact_owner`, which also moves
 * the contact's chats so "My leads" and the inbox agree.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OwnerResult = { ok: true } | { ok: false; error: string };

/**
 * Set (or clear, with `profileId` null) the owner of a contact. `branchId`
 * also moves the lead to that branch; left out, the branch stays.
 */
export async function setContactOwner(
  db: SupabaseClient,
  contactId: string,
  profileId: string | null,
  branchId?: string | null
): Promise<OwnerResult> {
  if (!UUID.test(contactId)) return { ok: false, error: 'Invalid contact' };
  if (profileId !== null && !UUID.test(profileId)) {
    return { ok: false, error: 'Invalid owner' };
  }
  if (branchId != null && !UUID.test(branchId)) {
    return { ok: false, error: 'Invalid branch' };
  }

  const { error } = await db.rpc('set_contact_owner', {
    p_contact: contactId,
    p_profile: profileId,
    p_branch: branchId ?? null,
  });
  if (error) {
    return {
      ok: false,
      error:
        error.code === '42501'
          ? 'Only an admin can change who owns a lead.'
          : error.message || 'Could not change the owner',
    };
  }
  return { ok: true };
}

export interface OwnerCandidate {
  profile_id: string;
  full_name: string;
  role: AccountRole;
}

/**
 * Who the Owner selector offers: members who can work leads (Counsellor and
 * up), by name. The current owner stays listed whatever their role, so the
 * closed control never shows a raw id.
 */
export function ownerCandidates<T extends OwnerCandidate>(
  members: readonly T[],
  currentOwner: string | null | undefined
): T[] {
  return members
    .filter((m) => hasMinRole(m.role, 'agent') || m.profile_id === currentOwner)
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}
