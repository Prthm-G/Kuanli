'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { FileCheck, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { formatCurrency } from '@/lib/currency';
import { loadApplicationTracker } from '@/lib/applications/queries';
import { loadLedger } from '@/lib/payments/queries';
import type { LedgerRow } from '@/lib/payments/types';
import { computeProgress } from '@/lib/applications/progress';
import type {
  DocStatus,
  TrackerContact,
  UnsortedDoc,
} from '@/lib/applications/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

/**
 * Application tracker: every lead at Application Started / Enrolled with
 * their document checklist. Inbound images/documents from these leads are
 * captured automatically (migration 045); counsellors classify them onto a
 * checklist slot, then verify (which archives the bytes into private
 * storage) or reject.
 */
export default function ApplicationsPage() {
  const { accountId } = useAuth();
  const [contacts, setContacts] = useState<TrackerContact[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Money state per contact, keyed by contact id. Documents and fees are the
  // two halves of "is this application actually progressing", so they belong
  // on the same row.
  const [ledger, setLedger] = useState<Map<string, LedgerRow>>(new Map());

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      setContacts(await loadApplicationTracker(supabase, accountId));
      try {
        const rows = await loadLedger(supabase, accountId);
        setLedger(new Map(rows.map((r) => [r.contactId, r])));
      } catch {
        // The document tracker is this page's job; a failed ledger fetch
        // hides the fee strip rather than taking the page down.
        setLedger(new Map());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load applications');
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function classify(doc: UnsortedDoc, docType: string) {
    if (!docType) return;
    setBusy(doc.documentId);
    const { error: err } = await createClient()
      .from('application_documents')
      .update({ doc_type: docType })
      .eq('id', doc.documentId);
    setBusy(null);
    if (err) toast.error(`Could not classify: ${err.message}`);
    else void load();
  }

  async function verify(documentId: string) {
    setBusy(documentId);
    try {
      const res = await fetch('/api/applications/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ documentId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      if (!body.archived) {
        toast.warning(
          `Verified, but the file could not be archived (${body.archive_error ?? 'media unavailable'}). Ask the lead to resend if a permanent copy is needed.`
        );
      } else {
        toast.success('Verified and archived');
      }
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Verify failed');
    } finally {
      setBusy(null);
    }
  }

  async function reject(documentId: string) {
    setBusy(documentId);
    const { data: userRes } = await createClient().auth.getUser();
    const { error: err } = await createClient()
      .from('application_documents')
      .update({
        status: 'rejected',
        reviewed_by: userRes.user?.id ?? null,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', documentId);
    setBusy(null);
    if (err) toast.error(`Could not reject: ${err.message}`);
    else void load();
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-foreground text-xl font-semibold">
            Applications
          </h1>
          <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
            <FileCheck className="h-3.5 w-3.5" />
            {contacts ? `${contacts.length} in the application phase` : '…'}
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
      {loading && <p className="text-muted-foreground text-sm">Loading…</p>}
      {!loading && !error && contacts?.length === 0 && (
        <p className="text-muted-foreground text-sm">
          No leads in the application phase yet. Leads land here when a roll
          number moves them to Application Started.
        </p>
      )}

      {contacts?.map((c) => {
        const progress = computeProgress(c.required);
        const money = ledger.get(c.contactId);
        return (
          <div
            key={c.contactId}
            className="border-border bg-card space-y-3 rounded-lg border p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-foreground font-medium">
                  {c.name || c.phone || 'Lead'}
                </span>
                {c.rollNumber && (
                  <Badge variant="outline">{c.rollNumber}</Badge>
                )}
                <Badge variant="secondary">{c.stage}</Badge>
                {progress.ready && (
                  <Badge>All documents verified — consider Enrolled</Badge>
                )}
              </div>
              <div className="flex items-center gap-3">
                {money && money.agreedTotal > 0 && (
                  <span
                    className={
                      'text-sm ' +
                      (money.outstanding > 0
                        ? 'text-muted-foreground'
                        : 'text-emerald-500')
                    }
                    title={
                      money.reported > 0
                        ? `${formatCurrency(money.reported, money.currency)} reported but not yet verified`
                        : undefined
                    }
                  >
                    {formatCurrency(money.received, money.currency)} /{' '}
                    {formatCurrency(money.agreedTotal, money.currency)}
                    {money.outstanding > 0 && (
                      <span className="text-muted-foreground">
                        {' '}
                        · {formatCurrency(money.outstanding, money.currency)} due
                      </span>
                    )}
                    {money.reported > 0 && (
                      <span className="ml-1 text-amber-500">
                        · {formatCurrency(money.reported, money.currency)}{' '}
                        unverified
                      </span>
                    )}
                  </span>
                )}
                <span className="text-muted-foreground text-sm">
                  {progress.verified}/{progress.total} verified
                </span>
                {c.conversationId && (
                  <Link
                    href={`/inbox?c=${c.conversationId}`}
                    className="border-border text-foreground hover:bg-muted/50 inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium"
                  >
                    Open chat
                  </Link>
                )}
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {c.required.map((r) => (
                <span
                  key={r.docType}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${statusClass(r.status)}`}
                >
                  {r.label}
                  <span className="opacity-70">· {r.status}</span>
                  {r.status === 'received' && r.documentId && (
                    <>
                      <button
                        className="font-medium underline-offset-2 hover:underline"
                        disabled={busy === r.documentId}
                        onClick={() => void verify(r.documentId!)}
                      >
                        Verify
                      </button>
                      <button
                        className="font-medium underline-offset-2 hover:underline"
                        disabled={busy === r.documentId}
                        onClick={() => void reject(r.documentId!)}
                      >
                        Reject
                      </button>
                    </>
                  )}
                </span>
              ))}
            </div>

            {c.unsorted.length > 0 && (
              <div className="space-y-2">
                <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                  Received, not yet sorted
                </p>
                {c.unsorted.map((u) => (
                  <div
                    key={u.documentId}
                    className="border-border flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm"
                  >
                    <span className="text-foreground min-w-0 flex-1 truncate">
                      {u.contentText || u.contentType || 'Attachment'}
                      <span className="text-muted-foreground">
                        {' '}
                        · {new Date(u.createdAt).toLocaleString()}
                      </span>
                    </span>
                    {u.mediaUrl && (
                      <a
                        href={u.mediaUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary text-xs font-medium hover:underline"
                      >
                        View
                      </a>
                    )}
                    <select
                      className="border-border bg-background text-foreground rounded border p-1 text-xs"
                      defaultValue=""
                      disabled={busy === u.documentId}
                      onChange={(e) => void classify(u, e.target.value)}
                    >
                      <option value="">Classify as…</option>
                      {c.required.map((r) => (
                        <option key={r.docType} value={r.docType}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function statusClass(status: DocStatus): string {
  switch (status) {
    case 'verified':
      return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500';
    case 'received':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-500';
    case 'rejected':
      return 'border-red-500/40 bg-red-500/10 text-red-400';
    default:
      return 'border-border bg-muted/40 text-muted-foreground';
  }
}
