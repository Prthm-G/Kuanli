'use client';

import { useEffect, useState } from 'react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { loadWorklist } from '@/lib/followups/queries';
import { actionableCount } from '@/lib/followups/due';

/** Re-check on this cadence so a day boundary or a colleague's edit shows up
 *  without a reload. Follow-ups move on the scale of hours, not seconds, so
 *  polling beats holding a realtime channel open for this. */
const REFRESH_MS = 5 * 60 * 1000;

/**
 * How many follow-ups are actionable right now (overdue or due today), for the
 * sidebar badge. Future commitments are excluded on purpose: a badge that is
 * permanently non-zero is a badge nobody looks at.
 *
 * Unlike `useTotalUnread` this does not subscribe to realtime — the worklist
 * comes from an RPC that joins four tables, so there is no single table whose
 * changefeed would keep it correct.
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

    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);

    return () => {
      cancelled = true;
      // Zero the badge as the account goes away, so a sign-out or an account
      // switch cannot leave the previous account's count on screen.
      setCount(0);
      clearInterval(timer);
    };
  }, [accountId]);

  return count;
}
