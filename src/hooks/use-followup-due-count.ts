'use client';

import { useEffect, useState } from 'react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { loadWorklist } from '@/lib/followups/queries';
import { actionableCount } from '@/lib/followups/due';
import { onFollowUpsChanged } from '@/lib/followups/events';

/** Re-check on this cadence so a day boundary shows up without a reload. */
const REFRESH_MS = 5 * 60 * 1000;

/**
 * How many follow-ups are actionable right now (overdue or due today), for the
 * sidebar badge. Future commitments are excluded on purpose: a badge that is
 * permanently non-zero is a badge nobody looks at.
 *
 * Team-wide, like the Follow-ups page. It refreshes the moment this tab logs a
 * follow-up, when anyone's entry changes (realtime on `follow_up_entries`,
 * migration 093), when the tab comes back into view, and on the poll above.
 * Each signal re-runs the worklist RPC rather than patching the count, because
 * the newest entry per contact decides what is open.
 */
export function useFollowupDueCount(): number {
  const { accountId } = useAuth();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;

    const refresh = async () => {
      try {
        const rows = await loadWorklist(createClient(), accountId);
        if (!cancelled) setCount(actionableCount(rows));
      } catch {
        // The badge is decoration. A failed poll must never surface an error
        // over whatever page the user is actually on.
      }
    };

    // A burst of changes (a save plus its realtime echo) costs one query.
    let pending: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        void refresh();
      }, 500);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') soon();
    };

    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    const off = onFollowUpsChanged(soon);
    document.addEventListener('visibilitychange', onVisible);
    const supabase = createClient();
    const channel = supabase
      .channel(`followup-due-${accountId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'follow_up_entries',
          filter: `account_id=eq.${accountId}`,
        },
        soon
      )
      .subscribe();

    return () => {
      cancelled = true;
      // Zero the badge as the account goes away, so a sign-out or an account
      // switch cannot leave the previous account's count on screen.
      setCount(0);
      clearInterval(timer);
      if (pending) clearTimeout(pending);
      off();
      document.removeEventListener('visibilitychange', onVisible);
      void supabase.removeChannel(channel);
    };
  }, [accountId]);

  return count;
}
