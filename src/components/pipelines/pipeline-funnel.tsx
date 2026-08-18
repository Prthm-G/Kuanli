'use client';

import { useEffect, useState } from 'react';

import { createClient } from '@/lib/supabase/client';
import { formatMinutes, pct } from '@/lib/analytics/format';

interface FunnelRow {
  stage: string;
  position: number;
  color: string;
  current: number;
  reached: number | null;
  median_hours: number | null;
}

/**
 * Funnel tab: this pipeline's ladder with reach, drop-off, and median
 * time-in-stage, off the `pipeline_funnel` RPC (migration 048). Conversion is
 * reached-vs-previous-rung; time-in-stage comes from deal_stage_events and
 * fills in as history accrues (the log started 2026-08-18).
 */
export function PipelineFunnel({
  accountId,
  pipelineId,
}: {
  accountId: string;
  pipelineId: string;
}) {
  const [rows, setRows] = useState<FunnelRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // No state resets here: the parent keys this component on the pipeline
    // id, so switching boards remounts it with fresh null state.
    if (!accountId || !pipelineId) return;
    let cancelled = false;
    void (async () => {
      const { data, error: err } = await createClient().rpc('pipeline_funnel', {
        p_account_id: accountId,
        p_pipeline_id: pipelineId,
      });
      if (cancelled) return;
      if (err) setError(err.message);
      else setRows((data ?? []) as FunnelRow[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, pipelineId]);

  if (error) return <p className="p-4 text-sm text-red-400">{error}</p>;
  if (!rows)
    return <p className="text-muted-foreground p-4 text-sm">Loading…</p>;

  const ladder = rows.filter((r) => r.reached !== null);
  const lost = rows.find((r) => r.reached === null);
  const max = Math.max(1, ...ladder.map((r) => r.reached ?? 0));

  return (
    <div className="space-y-2">
      {ladder.map((r, i) => {
        const prev = i > 0 ? (ladder[i - 1].reached ?? 0) : null;
        return (
          <div
            key={r.stage}
            className="border-border bg-card grid grid-cols-[140px_minmax(0,1fr)_repeat(3,90px)] items-center gap-3 rounded-lg border px-4 py-3 max-md:grid-cols-[110px_minmax(0,1fr)_70px]"
          >
            <span className="text-foreground truncate text-sm font-medium">
              {r.stage}
            </span>
            <div className="bg-muted/60 h-4 overflow-hidden rounded">
              <div
                className="h-full rounded"
                style={{
                  width: `${((r.reached ?? 0) / max) * 100}%`,
                  backgroundColor: r.color,
                }}
              />
            </div>
            <span className="text-foreground text-right text-sm">
              {r.reached}
              <span className="text-muted-foreground block text-xs">
                reached
              </span>
            </span>
            <span className="text-foreground text-right text-sm max-md:hidden">
              {prev === null ? '—' : pct(r.reached ?? 0, prev)}
              <span className="text-muted-foreground block text-xs">
                conversion
              </span>
            </span>
            <span className="text-foreground text-right text-sm max-md:hidden">
              {r.median_hours === null
                ? '—'
                : formatMinutes(r.median_hours * 60)}
              <span className="text-muted-foreground block text-xs">
                in stage
              </span>
            </span>
          </div>
        );
      })}
      {lost && (
        <div className="border-border flex items-center justify-between rounded-lg border border-dashed px-4 py-3">
          <span className="text-muted-foreground text-sm font-medium">
            Lost (exit)
          </span>
          <span className="text-foreground text-sm">{lost.current}</span>
        </div>
      )}
      <p className="text-muted-foreground px-1 text-xs">
        “Reached” counts every deal that ever hit the stage on this board;
        “conversion” compares against the previous rung. Time-in-stage builds up
        as the stage log accrues.
      </p>
    </div>
  );
}
