'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw, TrendingUp } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { canViewGrowth } from '@/lib/auth/roles';
import { loadGrowthLive, loadGrowthSnapshots } from '@/lib/growth/queries';
import {
  AD_CLICK_STALE_DAYS,
  cpeLabel,
  daysSince,
  istDate,
  inr,
  numberLabel,
} from '@/lib/growth/format';
import type { GrowthLive, GrowthSnapshot } from '@/lib/growth/types';
import { Button } from '@/components/ui/button';

/**
 * Owner-only growth page (KB-GROWTH-R1). Live signals come from the
 * `growth_live` RPC over Kuanli's own tables; spend, enrolments and proposals
 * come from the weekly scorecard snapshots (`growth_snapshots`). Both are
 * owner-gated in the database (migration 078); the redirect here only keeps
 * other roles off a page that would load empty.
 */
export default function GrowthPage() {
  const router = useRouter();
  const { accountId, accountRole, profileLoading } = useAuth();
  const allowed = accountRole !== null && canViewGrowth(accountRole);

  const [live, setLive] = useState<GrowthLive | null>(null);
  const [snapshots, setSnapshots] = useState<GrowthSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (accountRole !== null && !allowed) router.replace('/dashboard');
  }, [accountRole, allowed, router]);

  const load = useCallback(async () => {
    if (!accountId || !allowed) return;
    setLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const [l, s] = await Promise.all([
        loadGrowthLive(supabase, accountId),
        loadGrowthSnapshots(supabase, accountId),
      ]);
      setLive(l);
      setSnapshots(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load growth data');
    } finally {
      setLoading(false);
    }
  }, [accountId, allowed]);

  useEffect(() => {
    void load();
  }, [load]);

  const latest = snapshots[0]?.payload ?? null;
  const adNames = useMemo(
    () => new Map((latest?.ads ?? []).map((a) => [a.ad_id, a.ad_name])),
    [latest]
  );

  if (!allowed) {
    // A failed profile load leaves the role null; say so instead of a blank page.
    return !profileLoading && accountRole === null ? (
      <p className="text-muted-foreground p-6 text-sm">
        Could not load your account role. Refresh the page.
      </p>
    ) : null;
  }

  const clickAge = daysSince(live?.lastAdReferralAt ?? null);
  const clicksStale = clickAge === null || clickAge > AD_CLICK_STALE_DAYS;

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-foreground text-xl font-semibold">Growth</h1>
          <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
            <TrendingUp className="h-3.5 w-3.5" />
            Owner only · ads funnel for the current intake ·{' '}
            {snapshots[0]
              ? `weekly data as of ${snapshots[0].snapshotDate}`
              : 'no weekly snapshot yet'}
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

      {live && clicksStale && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
          {clickAge === null
            ? 'No ad click has ever been captured.'
            : `No ad click captured for ${clickAge} days (last ${istDate(live.lastAdReferralAt)}).`}{' '}
          If ads are running, they may point at a WhatsApp number Kuanli no
          longer receives.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Intake enrolled"
          value={
            latest ? `${latest.intake.total} / ${latest.intake.target}` : '—'
          }
          hint={
            latest
              ? `checkpoint ${latest.intake.checkpoint} by ${latest.intake.checkpoint_date}`
              : undefined
          }
        />
        <Stat
          label="Ad-attributed"
          value={
            latest ? `${latest.intake.ads} / ${latest.intake.target_ads}` : '—'
          }
          hint={
            latest ? `checkpoint ${latest.intake.checkpoint_ads}` : undefined
          }
        />
        <Stat
          label="14-day cost per enrolment"
          value={
            latest ? cpeLabel(latest.window14.spend, latest.window14.cpe) : '—'
          }
          hint={latest ? `${inr(latest.window14.spend)} spend` : undefined}
        />
        <Stat
          label="Last ad click captured"
          value={
            clickAge === null
              ? 'never'
              : clickAge === 0
                ? 'today'
                : `${clickAge}d ago`
          }
          alert={!!live && clicksStale}
        />
      </div>

      <Section title="Live · last 30 days">
        <Table
          head={[
            'Day',
            'New conversations',
            'Ad clicks (latest per conversation)',
          ]}
          loading={loading}
          empty="No conversations in the window."
          rows={live?.daily.map((d) => [
            d.day,
            d.newConversations,
            d.adReferrals,
          ])}
        />
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Conversations by latest ad clicked (live)">
          <Table
            head={['Ad', 'Conversations', 'Last click']}
            loading={loading}
            empty="No ad clicks in the window."
            rows={live?.byAd.map((a) => [
              adNames.get(a.adSourceId) ?? a.adSourceId,
              a.conversations,
              istDate(a.lastAt),
            ])}
          />
        </Section>
        <Section title="Conversations by WhatsApp number (live)">
          <Table
            head={['Number', 'Conversations', 'Last']}
            loading={loading}
            empty="No conversations in the window."
            rows={live?.byNumber.map((n) => [
              numberLabel(n.phoneNumberId, n.displayPhoneNumber),
              n.conversations,
              istDate(n.lastAt),
            ])}
          />
        </Section>
      </div>

      <Section title="New contacts by source (live)">
        <Table
          head={['Source', 'Contacts']}
          loading={loading}
          empty="No new contacts in the window."
          rows={live?.contactsBySource.map((s) => [s.source, s.contacts])}
        />
      </Section>

      <Section title="Proposals (each needs the owner's OK)">
        <List
          loading={loading}
          empty="No proposals this week."
          items={latest?.proposals.map((p) => `${p.kind} · ${p.text}`)}
        />
      </Section>

      <Section title="Blockers">
        <List
          loading={loading}
          empty="No open blockers."
          items={latest?.blockers.map(
            (b) =>
              `${b.text} · ${b.owner}${b.since ? ` · since ${b.since}` : ''}`
          )}
        />
      </Section>

      <Section title="Cells (scorecard)">
        <Table
          head={['Cell', 'Spend', 'Conversations', 'Enrolled']}
          loading={loading}
          empty="No snapshot yet."
          rows={latest?.cells.map((c) => [
            c.cell,
            inr(c.spend),
            c.conversations,
            c.enrolled,
          ])}
        />
      </Section>

      <Section title="Ads (scorecard)">
        <Table
          head={['Ad', 'Cell', 'Spend', 'Conversations', 'Enrolled']}
          loading={loading}
          empty="No snapshot yet."
          rows={latest?.ads
            .slice()
            .sort((a, b) => b.spend - a.spend)
            .slice(0, 15)
            .map((a) => [
              a.ad_name,
              a.cell,
              inr(a.spend),
              a.conversations,
              a.enrolled,
            ])}
        />
      </Section>

      <Section title="Weekly trend">
        <Table
          head={[
            'Week',
            '14-day spend',
            'Ad-attributed enrolments',
            'Cost per enrolment',
          ]}
          loading={loading}
          empty="No snapshots yet."
          rows={snapshots.map((s) => [
            s.snapshotDate,
            inr(s.payload.window14.spend),
            s.payload.window14.enrolments,
            cpeLabel(s.payload.window14.spend, s.payload.window14.cpe),
          ])}
        />
      </Section>

      <Section title="SEO">
        <p className="text-muted-foreground text-sm">
          {latest
            ? `${latest.seo.status}${latest.seo.checked ? ` (checked ${latest.seo.checked})` : ''}`
            : '—'}
        </p>
      </Section>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  alert = false,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  alert?: boolean;
}) {
  return (
    <div
      className={`bg-card rounded-lg border p-3 ${alert ? 'border-red-500/40' : 'border-border'}`}
    >
      <p className="text-muted-foreground text-xs">{label}</p>
      <p
        className={`mt-0.5 text-2xl font-semibold ${alert ? 'text-red-400' : 'text-foreground'}`}
      >
        {value}
      </p>
      {hint && <p className="text-muted-foreground mt-0.5 text-xs">{hint}</p>}
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

function List({
  items,
  loading,
  empty,
}: {
  items: string[] | undefined;
  loading: boolean;
  empty: string;
}) {
  if (loading) return <p className="text-muted-foreground text-sm">Loading…</p>;
  if (!items || items.length === 0)
    return <p className="text-muted-foreground text-sm">{empty}</p>;
  return (
    <ul className="border-border divide-border divide-y rounded-lg border text-sm">
      {items.map((t, i) => (
        <li key={i} className="text-foreground px-3 py-2">
          {t}
        </li>
      ))}
    </ul>
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
      <table className="w-full text-sm">
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
            rows?.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
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
