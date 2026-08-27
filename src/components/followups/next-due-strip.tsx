'use client';

import { useEffect, useState } from 'react';
import { ClipboardCheck, Plus } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { loadTimeline } from '@/lib/followups/queries';
import { METHOD_LABEL, type TimelineItem } from '@/lib/followups/types';
import { bucketFor, describeDue } from '@/lib/followups/due';
import { LogDialog } from './log-dialog';

interface NextDueStripProps {
  contactId: string;
  contactName?: string | null;
  conversationId?: string | null;
}

/**
 * Compact follow-up state for the inbox sidebar: what is owed to this student
 * and the button to log the next touch. The full history lives in the contact
 * sheet; the counsellor mid-conversation only needs the one line.
 *
 * Reads the timeline rather than the worklist because the worklist is scoped
 * to the whole account, and only the newest MANUAL entry can carry an open
 * commitment (migration 054) — which, in a newest-first timeline, is simply
 * the first manual row.
 */
export function NextDueStrip({
  contactId,
  contactName,
  conversationId,
}: NextDueStripProps) {
  const { accountId, accountRole } = useAuth();
  const [latest, setLatest] = useState<TimelineItem | null>(null);
  const [open, setOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const canLog = accountRole !== null && accountRole !== 'viewer';

  // Inline async fetch rather than a useCallback the effect invokes: calling
  // setState directly from an effect body is a cascading render. Same shape as
  // use-total-unread.
  useEffect(() => {
    if (!accountId || !contactId) return;
    let cancelled = false;

    void (async () => {
      try {
        const items = await loadTimeline(createClient(), accountId, contactId);
        if (!cancelled) {
          setLatest(items.find((i) => i.source === 'manual') ?? null);
        }
      } catch {
        // The strip is context, not the conversation. A failed load leaves it
        // blank rather than pushing an error over the thread.
        if (!cancelled) setLatest(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [accountId, contactId, reloadKey]);

  const due = latest?.nextDueAt ?? null;
  const overdue = due ? bucketFor(due) === 'overdue' : false;

  return (
    <div>
      <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs font-medium tracking-wider uppercase">
        <ClipboardCheck className="h-3 w-3" />
        Follow-up
      </div>
      <div className="mt-2 space-y-2 px-1">
        {due ? (
          <p
            className={`text-xs ${overdue ? 'text-red-400' : 'text-foreground'}`}
          >
            {latest?.nextMethod ? METHOD_LABEL[latest.nextMethod] : 'Follow-up'}
            , {describeDue(due)}
          </p>
        ) : (
          <p className="text-muted-foreground text-xs">
            {latest ? 'Nothing owed' : 'No follow-ups logged'}
          </p>
        )}
        {latest && (
          <p className="text-muted-foreground line-clamp-2 text-xs">
            {latest.summary}
          </p>
        )}
        {canLog && (
          <button
            onClick={() => setOpen(true)}
            className="border-border text-foreground hover:bg-muted/50 inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium"
          >
            <Plus className="mr-1 h-3 w-3" />
            Log follow-up
          </button>
        )}
      </div>

      <LogDialog
        open={open}
        onOpenChange={setOpen}
        contactId={contactId}
        contactName={contactName}
        conversationId={conversationId}
        onLogged={() => setReloadKey((k) => k + 1)}
      />
    </div>
  );
}
