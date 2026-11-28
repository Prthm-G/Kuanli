'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw, TrendingUp } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { canViewGrowth } from '@/lib/auth/roles';
import {
  loadBranchFunnel,
  loadBranches,
  loadGrowthLive,
  loadGrowthSnapshots,
} from '@/lib/growth/queries';
import {
  AD_CLICK_STALE_DAYS,
  coverageLine,
  cpeLabel,
  daysSince,
  istDate,
  inr,
  numberLabel,
} from '@/lib/growth/format';
import {
  adRows,
  branchRows,
  formRows,
  stateRows,
} from '@/lib/growth/funnel-rows';
import type {
  BranchFunnel,
  GrowthBranch,
  GrowthLive,
  GrowthSnapshot,
} from '@/lib/growth/types';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

/**
 * Owner-only growth page (KB-GROWTH-R1, R2). Branch tabs (All, Patiala,
 * Mohali) filter every live table. Live signals come from `growth_live`;
 * daily spend, costs, spend by state and form leads come from
 * `growth_branch_funnel` over `meta_ad_daily` (migration 105). The weekly
 * snapshot (`growth_snapshots`) is still the source for proposals, blockers
 * and SEO. All are owner-gated in the database (078, 105); the redirect here
 * only keeps other roles off a page that would load empty.
 */
export default function GrowthPage() {
  const router = useRouter();
  const { accountId, accountRole, profileLoading } = useAuth();
  const allowed = accountRole !== null && canViewGrowth(accountRole);

  const [live, setLive] = useState<GrowthLive | null>(null);
  const [snapshots, setSnapshots] = useState<GrowthSnapshot[]>([]);
  const [branches, setBranches] = useState<GrowthBranch[]>([]);
  const [branch, setBranch] = useState('all');
  const [funnel, setFunnel] = useState<BranchFunnel | null>(null);
  const reqRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (accountRole !== null && !allowed) router.replace('/dashboard');
  }, [accountRole, allowed, router]);

  // Every setter runs in a promise callback, so the effect below sets no
  // state synchronously.
  const fetchGrowth = useCallback(async () => {
    if (!accountId || !allowed) return;
    const supabase = createClient();
    const branchId = branch === 'all' ? null : branch;
    const req = ++reqRef.current;
    // A slower response for another tab never overwrites the current one.
    await Promise.all([
      loadGrowthLive(supabase, accountId, 30, branchId),
      loadGrowthSnapshots(supabase, accountId),
      loadBranchFunnel(supabase, accountId, 30, branchId),
      loadBranches(supabase, accountId),
    ])
      .then(([l, s, f, b]) => {
        if (req !== reqRef.current) return;
        setLive(l);
        setSnapshots(s);
        setFunnel(f);
        setBranches(b);
      })
      .catch((e) => {
        if (req !== reqRef.current) return;
        setError(e instanceof Error ? e.message : 'Could not load growth data');
      })
      .finally(() => {
        if (req === reqRef.current) setLoading(false);
      });
  }, [accountId, allowed, branch]);

  // Refresh: show the spinner and clear the last error, then refetch.
  const load = useCallback(async () => {
    if (!accountId || !allowed) return;
    setLoading(true);
    setError(null);
    await fetchGrowth();
  }, [accountId, allowed, fetchGrowth]);

  // accountId or access arriving (or accountId changing after a sign-out in
  // another tab) refetches in the effect below; reset for it while rendering
  // instead.
  const [prevDeps, setPrevDeps] = useState({ accountId, allowed, branch });
  if (
    accountId !== prevDeps.accountId ||
    allowed !== prevDeps.allowed ||
    branch !== prevDeps.branch
  ) {
    setPrevDeps({ accountId, allowed, branch });
    if (accountId && allowed) {
      setLoading(true);
      setError(null);
    }
  }

  useEffect(() => {
    void fetchGrowth();
  }, [fetchGrowth]);

  const latest = snapshots[0]?.payload ?? null;
  const allTab = branch === 'all';
  const codeToName = (c: string | null) =>
    branches.find((b) => b.code === c)?.name ?? 'No branch';

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

      <Tabs
        value={branch}
        onValueChange={(v) => {
          if (v != null) setBranch(String(v));
        }}
      >
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          {branches.map((b) => (
            <TabsTrigger key={b.id} value={b.id}>
              {b.name}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

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
          hint={
            funnel?.coverage.length
              ? 'weekly scorecard; daily spend is in the tables below'
              : latest
                ? `${inr(latest.window14.spend)} spend`
                : undefined
          }
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

      <p className="text-muted-foreground text-xs">
        {coverageLine(funnel?.coverage ?? [], codeToName)}
      </p>

      {allTab && (
        <Section title="Branches · last 30 days">
          <Table
            head={[
              'Branch',
              'Chats',
              'Ad',
              'Ad (exact ad unknown)',
              'Organic',
              'Qualified',
              'App started',
              'Provisional',
              'Fee',
              'Enrolled',
              'Spend',
              'Cost/ad chat',
              'Cost/provisional',
              'Cost/enrolment',
            ]}
            loading={loading}
            empty="No chats in the window."
            rows={funnel ? branchRows(funnel) : undefined}
          />
        </Section>
      )}

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
        <Section title="Ads · chats, funnel and spend (last 30 days)">
          <Table
            head={[
              'Ad',
              ...(allTab ? ['Branch'] : []),
              'Chats',
              'Qualified',
              'Provisional',
              'Enrolled',
              'Spend',
              'Cost/chat',
              'Cost/provisional',
              'Cost/enrolment',
            ]}
            loading={loading}
            empty="No ad chats or spend in the window."
            rows={funnel ? adRows(funnel, allTab) : undefined}
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

      <Section title="Form leads by form (form leads carry no ad id)">
        <Table
          head={[
            'Form',
            'Branch',
            'Leads',
            'Contacts',
            'Qualified',
            'App started',
            'Provisional',
            'Fee',
            'Enrolled',
          ]}
          loading={loading}
          empty="No form leads in the window."
          rows={funnel ? formRows(funnel) : undefined}
        />
      </Section>

      <Section title="Spend by state (Meta reports spend, impressions and clicks by state, not chats)">
        <Table
          head={['State', 'Branch', 'Spend', 'Impressions', 'Clicks']}
          loading={loading}
          empty="No spend by state in the window."
          rows={funnel ? stateRows(funnel) : undefined}
        />
      </Section>

      {allTab && (
        <h2 className="text-foreground pt-2 text-base font-semibold">
          Weekly scorecard
          {snapshots[0] ? ` (as of ${snapshots[0].snapshotDate})` : ''}
        </h2>
      )}

      {allTab && (
        <>
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
        </>
      )}
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
