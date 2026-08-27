'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardCheck, Printer, RefreshCw } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { loadWorklist } from '@/lib/followups/queries';
import { actionableCount, bucketWorklist } from '@/lib/followups/due';
import { buildCallSheetHtml } from '@/lib/followups/call-sheet';
import type { WorklistRow } from '@/lib/followups/types';
import { loadLedger } from '@/lib/payments/queries';
import type { LedgerRow } from '@/lib/payments/types';
import { Worklist } from '@/components/followups/worklist';
import { ApprovalsQueue } from '@/components/payments/approvals-queue';
import { LedgerTable } from '@/components/payments/ledger-table';
import { StudentPayments } from '@/components/payments/student-payments';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';

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

  const [ledger, setLedger] = useState<LedgerRow[] | null>(null);
  const [ledgerLoading, setLedgerLoading] = useState(true);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  // The per-student drawer opened from a ledger row. Kept here rather than in
  // the table so recording a payment can refresh the ledger behind it.
  const [openStudent, setOpenStudent] = useState<LedgerRow | null>(null);

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

  const loadPayments = useCallback(async () => {
    if (!accountId) return;
    setLedgerLoading(true);
    setLedgerError(null);
    try {
      setLedger(await loadLedger(createClient(), accountId));
    } catch (e) {
      setLedgerError(
        e instanceof Error ? e.message : 'Could not load payments'
      );
    } finally {
      setLedgerLoading(false);
    }
  }, [accountId]);

  // Only fetched once the Payments tab is actually opened: the ledger is a
  // four-table RPC and most visits here are about follow-ups.
  useEffect(() => {
    if (view === 'payments') void loadPayments();
  }, [view, loadPayments]);

  const due = useMemo(() => actionableCount(rows ?? []), [rows]);
  const overdue = useMemo(
    () => bucketWorklist(rows ?? []).overdue.length,
    [rows]
  );

  const awaitingCheck = ledger?.filter((r) => r.reported > 0).length ?? 0;

  const tabs: { key: View; label: string }[] = [
    { key: 'followups', label: `Follow-ups (${due})` },
    {
      key: 'payments',
      label: awaitingCheck > 0 ? `Payments (${awaitingCheck})` : 'Payments',
    },
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
        <div className="flex items-center gap-2">
          {view === 'followups' && (
            <Button
              variant="outline"
              onClick={() => {
                // The paper register a counsellor works through in a day —
                // overdue + today only, blank outcome column to write on.
                const w = window.open('', '_blank');
                if (!w) return;
                w.document.write(buildCallSheetHtml(rows ?? []));
                w.document.close();
                w.focus();
                w.print();
              }}
              disabled={loading || !rows || rows.length === 0}
            >
              <Printer className="mr-2 h-4 w-4" />
              Print call sheet
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => void (view === 'payments' ? loadPayments() : load())}
            disabled={view === 'payments' ? ledgerLoading : loading}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>
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
        <ApprovalsQueue
          refreshKey={ledger?.length ?? 0}
          onDecided={() => void loadPayments()}
        />
      )}

      {view === 'payments' && (
        <LedgerTable
          rows={ledger ?? []}
          loading={ledgerLoading}
          error={ledgerError}
          onOpenStudent={(contactId) =>
            setOpenStudent(
              ledger?.find((r) => r.contactId === contactId) ?? null
            )
          }
        />
      )}

      <Sheet
        open={!!openStudent}
        onOpenChange={(o) => !o && setOpenStudent(null)}
      >
        <SheetContent className="border-border bg-background w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle className="text-foreground">
              {openStudent?.name || openStudent?.phone || 'Student'}
            </SheetTitle>
          </SheetHeader>
          <div className="px-4 pb-6">
            {openStudent && (
              <StudentPayments
                contactId={openStudent.contactId}
                contactName={openStudent.name}
                onChanged={() => void loadPayments()}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
