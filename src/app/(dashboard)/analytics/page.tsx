'use client';

import { useCallback, useEffect, useState } from 'react';
import { BarChart3, RefreshCw } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { loadFunnelAnalytics } from '@/lib/analytics/queries';
import { pct, formatMinutes } from '@/lib/analytics/format';
import type { FunnelAnalytics } from '@/lib/analytics/types';
import { Button } from '@/components/ui/button';

/**
 * Funnel + campaign analytics off the `funnel_analytics` RPC. Sections:
 * totals, per-source campaign performance (first-touch ad attribution from
 * migration 040), the stage funnel (current vs ever-reached, with stage
 * history accruing in deal_stage_events since migration 042), interest
 * breakdown, and the first-response-time trend.
 */
export default function AnalyticsPage() {
  const { accountId } = useAuth();
  const [report, setReport] = useState<FunnelAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    setError(null);
    try {
      setReport(await loadFunnelAnalytics(createClient(), accountId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load analytics');
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const t = report?.totals;

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-foreground text-xl font-semibold">Analytics</h1>
          <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
            <BarChart3 className="h-3.5 w-3.5" />
            Funnel and campaign performance
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

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
          {error}
        </p>
      )}

      {t && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Leads" value={t.leads} />
          <Stat label="Reached application" value={t.reachedApplication} />
          <Stat label="Enrolled" value={t.enrolled} />
          <Stat label="Lost" value={t.lost} />
        </div>
      )}

      <Section title="Campaign performance">
        <Table
          head={[
            'Source',
            'Leads',
            'Qualified',
            'Counselor',
            'Application',
            'Enrolled',
            'Lost',
          ]}
          loading={loading}
          empty="No leads yet."
          rows={report?.sources.map((s) => [
            <span
              key="s"
              className="block max-w-[280px] truncate"
              title={s.source}
            >
              {s.source}
            </span>,
            s.leads,
            `${s.qualified} (${pct(s.qualified, s.leads)})`,
            `${s.counselor} (${pct(s.counselor, s.leads)})`,
            `${s.application} (${pct(s.application, s.leads)})`,
            `${s.enrolled} (${pct(s.enrolled, s.leads)})`,
            `${s.lost} (${pct(s.lost, s.leads)})`,
          ])}
        />
      </Section>

      <Section title="Funnel">
        <Table
          head={['Stage', 'Currently here', 'Ever reached', 'Of all leads']}
          loading={loading}
          empty="No deals yet."
          rows={report?.funnel.map((f) => [
            f.stage,
            f.current,
            f.reached ?? '—',
            f.reached !== null && t ? pct(f.reached, t.leads) : '—',
          ])}
        />
      </Section>

      <Section title="By university interest">
        <Table
          head={['University', 'Leads', 'Application', 'Enrolled', 'Lost']}
          loading={loading}
          empty="No interest data yet."
          rows={report?.interest.map((i) => [
            i.university,
            i.leads,
            `${i.application} (${pct(i.application, i.leads)})`,
            i.enrolled,
            i.lost,
          ])}
        />
      </Section>

      <Section title="First response time (last 14 days)">
        <Table
          head={['Day', 'Median response', 'Responses']}
          loading={loading}
          empty="No agent responses in the window."
          rows={report?.responseTrend.map((r) => [
            r.day,
            formatMinutes(r.medianMinutes),
            r.responses,
          ])}
        />
      </Section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-border bg-card rounded-lg border p-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="text-foreground mt-0.5 text-2xl font-semibold">{value}</p>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <h2 className="text-foreground text-sm font-semibold">{title}</h2>
      {children}
    </div>
  );
}

function Table({
  head,
  rows,
  loading,
  empty,
}: {
  head: string[];
  rows: Array<Array<React.ReactNode>> | undefined;
  loading: boolean;
  empty: string;
}) {
  return (
    <div className="border-border overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="bg-muted/50 text-muted-foreground text-left text-xs tracking-wider uppercase">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-border divide-y">
          {loading && (
            <tr>
              <td
                colSpan={head.length}
                className="text-muted-foreground p-6 text-center"
              >
                Loading…
              </td>
            </tr>
          )}
          {!loading && (!rows || rows.length === 0) && (
            <tr>
              <td
                colSpan={head.length}
                className="text-muted-foreground p-6 text-center"
              >
                {empty}
              </td>
            </tr>
          )}
          {!loading &&
            rows?.map((cells, i) => (
              <tr key={i} className="hover:bg-muted/30">
                {cells.map((c, j) => (
                  <td key={j} className="text-foreground px-3 py-2">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
