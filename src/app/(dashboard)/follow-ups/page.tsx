'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardCheck, RefreshCw } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { loadWorklist } from '@/lib/followups/queries';
import { actionableCount, bucketWorklist } from '@/lib/followups/due';
import type { WorklistRow } from '@/lib/followups/types';
import { Worklist } from '@/components/followups/worklist';
import { Button } from '@/components/ui/button';

/**
 * Follow-ups and payments. Two tabs on one page because they are the same
 * question asked twice about the same student: what do I owe them, and what do
 * they owe us. The tab state is local (same pattern as /pipelines) rather than
 * a route segment — there is nothing to deep-link to yet.
 */
type View = 'followups' | 'payments';

export default function FollowUpsPage() {
  const { accountId } = useAuth();
  const [view, setView] = useState<View>('followups');
  const [rows, setRows] = useState<WorklistRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    setError(null);
    try {
      setRows(await loadWorklist(createClient(), accountId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load follow-ups');
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const due = useMemo(() => actionableCount(rows ?? []), [rows]);
  const overdue = useMemo(
    () => bucketWorklist(rows ?? []).overdue.length,
    [rows]
  );

  const tabs: { key: View; label: string }[] = [
    { key: 'followups', label: `Follow-ups (${due})` },
    { key: 'payments', label: 'Payments' },
  ];

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-foreground text-xl font-semibold">Follow-ups</h1>
          <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
            <ClipboardCheck className="h-3.5 w-3.5" />
            {rows
              ? `${rows.length} open commitments · ${overdue} overdue`
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
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setView(t.key)}
            className={
              'flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ' +
              (view === t.key
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground')
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {view === 'followups' && (
        <Worklist
          rows={rows ?? []}
          loading={loading}
          error={error}
          onChanged={() => void load()}
        />
      )}

      {view === 'payments' && (
        <div className="border-border text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
          Payment tracking lands in the next change (KB-FEEPAY-R4-32).
        </div>
      )}
    </div>
  );
}
