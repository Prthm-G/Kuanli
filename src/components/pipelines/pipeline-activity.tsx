'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, Bot, User } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';

interface ActivityRow {
  id: string;
  changedAt: string;
  actor: string | null; // null = automation
  fromStage: string | null;
  toStage: string;
  dealTitle: string;
  contactLabel: string;
}

/**
 * Activity tab: the latest stage transitions across every board, from
 * deal_stage_events (migration 042). changed_by is a user id for manual
 * moves and NULL for automation (sweep / Auretris), which is exactly how the
 * feed labels them.
 */
export function PipelineActivity({ accountId }: { accountId: string }) {
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    void (async () => {
      const supabase = createClient();
      const [{ data, error: err }, { data: profiles }] = await Promise.all([
        supabase
          .from('deal_stage_events')
          .select(
            'id, changed_at, changed_by, ' +
              'from_stage:pipeline_stages!deal_stage_events_from_stage_id_fkey(name), ' +
              'to_stage:pipeline_stages!deal_stage_events_to_stage_id_fkey(name), ' +
              'deal:deals(title, contact:contacts(name, phone))'
          )
          .eq('account_id', accountId)
          .order('changed_at', { ascending: false })
          .limit(50),
        supabase
          .from('profiles')
          .select('user_id, full_name')
          .eq('account_id', accountId),
      ]);
      if (cancelled) return;
      if (err) {
        setError(err.message);
        return;
      }
      const names = new Map(
        (profiles ?? []).map((p) => [
          p.user_id as string,
          p.full_name as string,
        ])
      );
      type Raw = {
        id: string;
        changed_at: string;
        changed_by: string | null;
        from_stage: { name: string } | { name: string }[] | null;
        to_stage: { name: string } | { name: string }[] | null;
        deal: {
          title: string | null;
          contact:
            | { name: string | null; phone: string | null }
            | { name: string | null; phone: string | null }[]
            | null;
        } | null;
      };
      const one = <T,>(v: T | T[] | null): T | null =>
        Array.isArray(v) ? (v[0] ?? null) : v;
      setRows(
        ((data ?? []) as unknown as Raw[]).map((r) => {
          const deal = one(r.deal);
          const contact = one(deal?.contact ?? null);
          return {
            id: r.id,
            changedAt: r.changed_at,
            actor: r.changed_by
              ? (names.get(r.changed_by) ?? 'Team member')
              : null,
            fromStage: one(r.from_stage)?.name ?? null,
            toStage: one(r.to_stage)?.name ?? '?',
            dealTitle: deal?.title ?? 'Deal',
            contactLabel: contact?.name || contact?.phone || '',
          };
        })
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  if (error) return <p className="p-4 text-sm text-red-400">{error}</p>;
  if (!rows)
    return <p className="text-muted-foreground p-4 text-sm">Loading…</p>;
  if (rows.length === 0)
    return (
      <p className="text-muted-foreground p-4 text-sm">
        No stage changes recorded yet — the log started on 18 Aug 2026.
      </p>
    );

  return (
    <div className="border-border divide-border divide-y rounded-lg border">
      {rows.map((r) => (
        <div key={r.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
          <span
            className="text-muted-foreground shrink-0"
            title={r.actor ?? 'Automation'}
          >
            {r.actor ? (
              <User className="h-3.5 w-3.5" />
            ) : (
              <Bot className="h-3.5 w-3.5" />
            )}
          </span>
          <span className="text-foreground min-w-0 flex-1 truncate">
            {r.contactLabel || r.dealTitle}
            <span className="text-muted-foreground">
              {' '}
              · {r.actor ?? 'Automation'}
            </span>
          </span>
          <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs">
            {r.fromStage ?? 'created'}
            <ArrowRight className="h-3 w-3" />
            <span className="text-foreground font-medium">{r.toStage}</span>
          </span>
          <span className="text-muted-foreground shrink-0 text-xs">
            {new Date(r.changedAt).toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}
