'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Bot,
  GitBranch,
  Mail,
  MapPin,
  MessageSquare,
  Phone,
  StickyNote,
  User,
} from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { NextDueStrip } from '@/components/followups/next-due-strip';
import { describeDue } from '@/lib/followups/due';
import {
  METHOD_LABEL,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  type FollowUpMethod,
} from '@/lib/followups/types';
import {
  loadStudentTimeline,
  TIMELINE_PAGE,
  type StudentTimelineItem,
} from '@/lib/students/queries';
import { activityTitle, viaLabel } from '@/lib/students/activity';

const METHOD_ICON: Record<FollowUpMethod, typeof Phone> = {
  call: Phone,
  whatsapp: MessageSquare,
  email: Mail,
  in_person: MapPin,
};
const TONE_CLASS = {
  positive: 'bg-emerald-500/15 text-emerald-500',
  neutral: 'bg-muted text-muted-foreground',
  negative: 'bg-red-500/15 text-red-400',
} as const;

function iconFor(item: StudentTimelineItem) {
  if (item.kind === 'bot_follow_up') return Bot;
  if (item.kind === 'note') return StickyNote;
  if (item.kind === 'stage') return GitBranch;
  return item.method ? METHOD_ICON[item.method] : User;
}
function formatWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

interface ActivityTabProps {
  contactId: string;
  contactName?: string | null;
  conversationId?: string | null;
  refreshKey?: number;
}

/** Everything that happened to this student across linked records (student_timeline, migration 106), newest first. */
export function ActivityTab({
  contactId,
  contactName,
  conversationId = null,
  refreshKey = 0,
}: ActivityTabProps) {
  const { accountId } = useAuth();
  const [items, setItems] = useState<StudentTimelineItem[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [logKey, setLogKey] = useState(0);
  // Bumped by every first-page load, so a "Show older" page that lands after a refresh is dropped, not appended.
  const requestId = useRef(0);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const id = ++requestId.current;
    void (async () => {
      try {
        const rows = await loadStudentTimeline(
          createClient(),
          accountId,
          contactId
        );
        if (cancelled || id !== requestId.current) return;
        setItems(rows);
        setMore(rows.length === TIMELINE_PAGE);
        setError(null);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : 'Could not load activity');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, contactId, refreshKey, logKey]);

  async function loadMore() {
    if (!accountId || !items?.length) return;
    const id = requestId.current;
    setLoadingMore(true);
    try {
      const rows = await loadStudentTimeline(
        createClient(),
        accountId,
        contactId,
        items[items.length - 1].at
      );
      if (id !== requestId.current) return;
      setItems((prev) => [...(prev ?? []), ...rows]);
      setMore(rows.length === TIMELINE_PAGE);
    } catch (e) {
      if (id !== requestId.current) return;
      setError(e instanceof Error ? e.message : 'Could not load activity');
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="space-y-3">
      <NextDueStrip
        contactId={contactId}
        contactName={contactName}
        conversationId={conversationId}
        onLogged={() => setLogKey((k) => k + 1)}
      />
      {error && <p className="text-sm text-red-400">{error}</p>}
      {!error && !items && (
        <p className="text-muted-foreground text-sm">Loading…</p>
      )}
      {items && items.length === 0 && (
        <p className="text-muted-foreground text-sm">Nothing logged yet.</p>
      )}
      {items && items.length > 0 && (
        <ol className="space-y-2">
          {items.map((item) => {
            const Icon = iconFor(item);
            const via = viaLabel(item, contactId);
            const quiet =
              item.kind === 'bot_follow_up' || item.kind === 'stage';
            return (
              <li
                key={`${item.kind}-${item.id}`}
                className={
                  'border-border flex gap-3 rounded-lg border p-3 ' +
                  (quiet ? 'bg-muted/30' : 'bg-card')
                }
              >
                <Icon
                  className={
                    'mt-0.5 h-4 w-4 shrink-0 ' +
                    (quiet ? 'text-muted-foreground' : 'text-foreground')
                  }
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <span className="text-foreground font-medium">
                      {activityTitle(item)}
                    </span>
                    <span className="text-muted-foreground">
                      {formatWhen(item.at)}
                    </span>
                    {item.who && (
                      <span className="text-muted-foreground">
                        · {item.who}
                      </span>
                    )}
                    {via && (
                      <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5">
                        {via}
                      </span>
                    )}
                    {item.outcome && (
                      <span
                        className={
                          'rounded-full px-2 py-0.5 font-medium ' +
                          TONE_CLASS[OUTCOME_TONE[item.outcome]]
                        }
                      >
                        {OUTCOME_LABEL[item.outcome]}
                      </span>
                    )}
                  </div>
                  <p className="text-foreground mt-1 text-sm break-words whitespace-pre-wrap">
                    {item.summary}
                  </p>
                  {item.nextDueAt && (
                    <p className="text-muted-foreground mt-1 text-xs">
                      Next:{' '}
                      {item.nextMethod
                        ? METHOD_LABEL[item.nextMethod]
                        : 'follow-up'}
                      , {describeDue(item.nextDueAt)}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {more && (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={loadingMore}
          className="border-border text-foreground hover:bg-muted/50 w-full rounded-md border px-2.5 py-1 text-xs font-medium"
        >
          {loadingMore ? 'Loading…' : 'Show older'}
        </button>
      )}
    </div>
  );
}
