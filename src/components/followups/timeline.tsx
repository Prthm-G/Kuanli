'use client';

import { useEffect, useState } from 'react';
import { Bot, Mail, MapPin, MessageSquare, Phone, User } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { loadTimeline } from '@/lib/followups/queries';
import {
  METHOD_LABEL,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  type FollowUpMethod,
  type TimelineItem,
} from '@/lib/followups/types';
import { describeDue } from '@/lib/followups/due';

const METHOD_ICON: Record<FollowUpMethod, typeof Phone> = {
  call: Phone,
  whatsapp: MessageSquare,
  email: Mail,
  in_person: MapPin,
};

const TONE_CLASS: Record<'positive' | 'neutral' | 'negative', string> = {
  positive: 'bg-emerald-500/15 text-emerald-500',
  neutral: 'bg-muted text-muted-foreground',
  negative: 'bg-red-500/15 text-red-400',
};

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

interface TimelineProps {
  contactId: string;
  /** Bumped by the parent after a log to force a refetch. */
  refreshKey?: number;
}

/**
 * One contact's follow-up history: what counsellors did, interleaved with what
 * the automated ladder sent (migration 044). Automated rows are visually
 * quieter and marked "Auto" — they are context for the human reading the
 * thread, not work anyone did.
 */
export function FollowUpTimeline({ contactId, refreshKey = 0 }: TimelineProps) {
  const { accountId } = useAuth();
  const [items, setItems] = useState<TimelineItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The fetch lives inline in the effect (rather than a useCallback the
  // effect calls) because a directly-invoked setState in an effect body is a
  // cascading render the compiler rejects. Same shape as use-total-unread.
  useEffect(() => {
    if (!accountId || !contactId) return;
    let cancelled = false;

    void (async () => {
      try {
        const rows = await loadTimeline(createClient(), accountId, contactId);
        if (cancelled) return;
        setItems(rows);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(
          e instanceof Error ? e.message : 'Could not load the timeline'
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [accountId, contactId, refreshKey]);

  if (error) return <p className="p-4 text-sm text-red-400">{error}</p>;
  if (!items)
    return <p className="text-muted-foreground p-4 text-sm">Loading…</p>;
  if (items.length === 0)
    return (
      <p className="text-muted-foreground p-4 text-sm">
        No follow-ups yet. Log the first one to start the history.
      </p>
    );

  return (
    <ol className="space-y-2">
      {items.map((item) => {
        const Icon =
          item.source === 'auto'
            ? Bot
            : item.method
              ? METHOD_ICON[item.method]
              : User;
        return (
          <li
            key={`${item.source}-${item.entryId}`}
            className={
              'border-border flex gap-3 rounded-lg border p-3 ' +
              (item.source === 'auto' ? 'bg-muted/30' : 'bg-card')
            }
          >
            <Icon
              className={
                'mt-0.5 h-4 w-4 shrink-0 ' +
                (item.source === 'auto'
                  ? 'text-muted-foreground'
                  : 'text-foreground')
              }
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span className="text-foreground font-medium">
                  {item.source === 'auto'
                    ? 'Automated follow-up'
                    : item.method
                      ? METHOD_LABEL[item.method]
                      : 'Follow-up'}
                </span>
                <span className="text-muted-foreground">
                  {formatWhen(item.occurredAt)}
                </span>
                {item.actorName && (
                  <span className="text-muted-foreground">
                    · {item.actorName}
                  </span>
                )}
                {item.source === 'auto' && (
                  <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5">
                    Auto
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
  );
}
