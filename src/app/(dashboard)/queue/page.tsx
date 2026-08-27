'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ListOrdered, RefreshCw } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { loadLeadQueue } from '@/lib/queue/queries';
import type { QueueLead } from '@/lib/queue/types';
import { sourceLabel } from '@/lib/contacts/source';
import { Button } from '@/components/ui/button';

/**
 * Counsellor work queue: every workable lead (all stages except Enrolled and
 * Lost), scored and sorted so the top of the list is always the right lead to
 * work next. The score is explained in lib/queue/score.ts; the tooltip on
 * each score shows its breakdown.
 */
type Segment = 'all' | 'needs-reply' | 'fresh' | 'cold';

const HOUR_MS = 3_600_000;

function inSegment(lead: QueueLead, segment: Segment): boolean {
  if (segment === 'all') return true;
  if (segment === 'needs-reply') return lead.score.isAwaitingReply;
  const age = lead.lastCustomerAt
    ? (Date.now() - new Date(lead.lastCustomerAt).getTime()) / HOUR_MS
    : null;
  if (segment === 'fresh') return age !== null && age < 24;
  // 'cold': silent for 3+ days, drifting toward the 14-day Lost line.
  return age !== null && age >= 72;
}

export default function QueuePage() {
  const { accountId } = useAuth();
  const [segment, setSegment] = useState<Segment>('all');
  const [leads, setLeads] = useState<QueueLead[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    setError(null);
    try {
      setLeads(await loadLeadQueue(createClient(), accountId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the queue');
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const awaiting = useMemo(
    () => leads?.filter((l) => l.score.isAwaitingReply).length ?? 0,
    [leads]
  );

  const visible = useMemo(
    () => leads?.filter((l) => inSegment(l, segment)) ?? null,
    [leads, segment]
  );

  const segments: { key: Segment; label: string }[] = useMemo(
    () => [
      { key: 'all', label: `All (${leads?.length ?? 0})` },
      { key: 'needs-reply', label: `Needs reply (${awaiting})` },
      {
        key: 'fresh',
        label: `Fresh (${leads?.filter((l) => inSegment(l, 'fresh')).length ?? 0})`,
      },
      {
        key: 'cold',
        label: `Going cold (${leads?.filter((l) => inSegment(l, 'cold')).length ?? 0})`,
      },
    ],
    [leads, awaiting]
  );

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-foreground text-xl font-semibold">Work queue</h1>
          <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
            <ListOrdered className="h-3.5 w-3.5" />
            {leads
              ? `${leads.length} workable leads · ${awaiting} awaiting a reply`
              : '…'}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>

      <div className="border-border bg-muted/40 flex gap-1 rounded-lg border p-1">
        {segments.map((t) => (
          <button
            key={t.key}
            onClick={() => setSegment(t.key)}
            className={
              'flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ' +
              (segment === t.key
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground')
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="border-border overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="bg-muted/50 text-muted-foreground text-left text-xs tracking-wider uppercase">
            <tr>
              <Th>Score</Th>
              <Th>Lead</Th>
              <Th>Stage</Th>
              <Th>Interest</Th>
              <Th>Waiting</Th>
              <Th>Msgs</Th>
              <Th>Source</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {loading && (
              <tr>
                <td
                  colSpan={8}
                  className="text-muted-foreground p-6 text-center"
                >
                  Loading…
                </td>
              </tr>
            )}
            {!loading && error && (
              <tr>
                <td colSpan={8} className="p-6 text-center text-red-400">
                  {error}
                </td>
              </tr>
            )}
            {!loading && !error && visible?.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="text-muted-foreground p-6 text-center"
                >
                  Nothing in this segment right now.
                </td>
              </tr>
            )}
            {!loading &&
              !error &&
              visible?.map((l) => (
                <tr key={l.dealId} className="hover:bg-muted/30">
                  <Td>
                    <span
                      className="text-foreground font-semibold"
                      title={`Engagement ${l.score.engagement} · Interest ${l.score.interest} · Awaiting reply ${l.score.awaitingReply} · Recency ${l.score.recency}`}
                    >
                      {l.score.total}
                    </span>
                  </Td>
                  <Td>
                    <div className="text-foreground">{l.name || <Dash />}</div>
                    <div className="text-muted-foreground font-mono text-xs">
                      {l.phone || <Dash />}
                    </div>
                  </Td>
                  <Td>{l.stageName}</Td>
                  <Td>{describeInterest(l) || <Dash />}</Td>
                  <Td>
                    {l.score.isAwaitingReply ? (
                      <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-500">
                        {describeWait(l.lastCustomerAt)}
                      </span>
                    ) : (
                      <Dash />
                    )}
                  </Td>
                  <Td>{l.customerMessages}</Td>
                  <Td>
                    <span title={l.adHeadline ?? l.adBody ?? undefined}>
                      {sourceLabel(l.source)}
                    </span>
                  </Td>
                  <Td>
                    {l.conversationId && (
                      <Link
                        href={`/inbox?c=${l.conversationId}`}
                        className="border-border text-foreground hover:bg-muted/50 inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium"
                      >
                        Open
                      </Link>
                    )}
                  </Td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function describeInterest(l: QueueLead): string {
  return [l.university, l.course, l.specialization].filter(Boolean).join(' · ');
}

/** "2h", "3d" — how long the lead has been waiting for a human reply. */
function describeWait(lastCustomerAt: string | null): string {
  if (!lastCustomerAt) return '';
  const hours = Math.max(
    0,
    (Date.now() - new Date(lastCustomerAt).getTime()) / 3_600_000
  );
  if (hours < 1) return 'now';
  if (hours < 24) return `${Math.floor(hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="px-3 py-2 font-medium">{children}</th>;
}

function Td({
  children,
  className = '',
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={`text-foreground px-3 py-2 ${className}`}>{children}</td>
  );
}

function Dash() {
  return <span className="text-muted-foreground">—</span>;
}
