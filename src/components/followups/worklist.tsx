'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Mail, MapPin, MessageSquare, Phone } from 'lucide-react';

import {
  BUCKET_LABEL,
  DUE_BUCKETS,
  bucketWorklist,
  describeDue,
  type DueBucket,
} from '@/lib/followups/due';
import {
  METHOD_LABEL,
  OUTCOME_LABEL,
  type FollowUpMethod,
  type WorklistRow,
} from '@/lib/followups/types';
import { LogDialog } from './log-dialog';

const METHOD_ICON: Record<FollowUpMethod, typeof Phone> = {
  call: Phone,
  whatsapp: MessageSquare,
  email: Mail,
  in_person: MapPin,
};

/** Overdue is the only bucket that gets alarm colour. Everything else is
 *  scheduled work, and colouring it would make the red mean nothing. */
const BUCKET_CLASS: Record<DueBucket, string> = {
  overdue: 'text-red-400',
  today: 'text-amber-500',
  week: 'text-muted-foreground',
  later: 'text-muted-foreground',
};

interface WorklistProps {
  rows: WorklistRow[];
  loading: boolean;
  error: string | null;
  onChanged: () => void;
}

/**
 * Every open commitment, grouped by when it comes due. A student appears at
 * most once: the worklist is driven by each contact's newest entry, so logging
 * a new follow-up moves or removes the row (migration 054).
 */
export function Worklist({ rows, loading, error, onChanged }: WorklistProps) {
  const [logging, setLogging] = useState<WorklistRow | null>(null);
  const buckets = useMemo(() => bucketWorklist(rows), [rows]);

  if (loading)
    return <p className="text-muted-foreground p-6 text-center">Loading…</p>;
  if (error) return <p className="p-6 text-center text-red-400">{error}</p>;
  if (rows.length === 0)
    return (
      <p className="text-muted-foreground p-6 text-center">
        Nothing is due. Commitments appear here when a follow-up sets a next
        date.
      </p>
    );

  return (
    <>
      <div className="space-y-6">
        {DUE_BUCKETS.filter((b) => buckets[b].length > 0).map((bucket) => (
          <section key={bucket}>
            <h2 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wider uppercase">
              {BUCKET_LABEL[bucket]}{' '}
              <span className="text-muted-foreground/70">
                ({buckets[bucket].length})
              </span>
            </h2>
            <div className="border-border divide-border divide-y rounded-lg border">
              {buckets[bucket].map((row) => {
                const Icon = row.nextMethod
                  ? METHOD_ICON[row.nextMethod]
                  : Phone;
                return (
                  <div
                    key={row.contactId}
                    className="hover:bg-muted/30 flex flex-wrap items-start gap-3 p-3"
                  >
                    <Icon className="text-muted-foreground mt-1 h-4 w-4 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-foreground text-sm font-medium">
                          {row.name || row.phone || 'Unnamed lead'}
                        </span>
                        {row.rollNumber && (
                          <span className="text-muted-foreground font-mono text-xs">
                            {row.rollNumber}
                          </span>
                        )}
                        {row.stageName && (
                          <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs">
                            {row.stageName}
                          </span>
                        )}
                        {row.university && (
                          <span className="text-muted-foreground text-xs">
                            {row.university}
                          </span>
                        )}
                      </div>
                      <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">
                        {row.outcome && (
                          <span className="text-foreground">
                            {OUTCOME_LABEL[row.outcome]} ·{' '}
                          </span>
                        )}
                        {row.summary}
                      </p>
                      <p className={`mt-1 text-xs ${BUCKET_CLASS[bucket]}`}>
                        {row.nextMethod
                          ? METHOD_LABEL[row.nextMethod]
                          : 'Follow-up'}
                        , {describeDue(row.nextDueAt)}
                        {row.loggedByName && (
                          <span className="text-muted-foreground">
                            {' '}
                            · promised by {row.loggedByName}
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      {row.conversationId && (
                        <Link
                          href={`/inbox?c=${row.conversationId}`}
                          className="border-border text-foreground hover:bg-muted/50 inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium"
                        >
                          Open chat
                        </Link>
                      )}
                      <button
                        onClick={() => setLogging(row)}
                        className="border-border text-foreground hover:bg-muted/50 inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium"
                      >
                        Log
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      {logging && (
        <LogDialog
          open
          onOpenChange={(o) => !o && setLogging(null)}
          contactId={logging.contactId}
          contactName={logging.name}
          conversationId={logging.conversationId}
          onLogged={() => {
            setLogging(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}
