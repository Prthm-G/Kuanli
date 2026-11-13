'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Landmark } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { canViewMoney } from '@/lib/auth/roles';
import { ApprovalsQueue } from '@/components/payments/approvals-queue';

/**
 * Owner and admin money desk. One tab for now, Acknowledge: payments that
 * counsellors logged and that wait for someone to check them against the
 * account. Acknowledging is the existing verify decision (self-acknowledge is
 * allowed). The database enforces the role in `verify_payment`; the redirect
 * only keeps other roles off a page that would load empty.
 */
type Tab = 'acknowledge';

export default function MoneyPage() {
  const router = useRouter();
  const { accountRole } = useAuth();
  const allowed = canViewMoney(accountRole);
  const [tab] = useState<Tab>('acknowledge');
  const [toDecide, setToDecide] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (accountRole !== null && !allowed) router.replace('/dashboard');
  }, [accountRole, allowed, router]);

  if (!allowed) return null;

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div>
        <h1 className="text-foreground text-xl font-semibold">Money</h1>
        <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
          <Landmark className="h-3.5 w-3.5" />
          Payments logged by the team, waiting for you to check them.
        </p>
      </div>

      <div
        role="tablist"
        className="border-border bg-muted/40 flex gap-1 rounded-lg border p-1"
      >
        <button
          role="tab"
          aria-selected={tab === 'acknowledge'}
          className="bg-background text-foreground flex-1 rounded-md px-3 py-1.5 text-sm font-medium shadow-sm"
        >
          {toDecide > 0 ? `Acknowledge (${toDecide})` : 'Acknowledge'}
        </button>
      </div>

      <ApprovalsQueue
        refreshKey={refreshKey}
        onDecided={() => setRefreshKey((k) => k + 1)}
        onCountChange={setToDecide}
      />
      {toDecide === 0 && (
        <p className="text-muted-foreground text-sm">
          Nothing is waiting to be acknowledged.
        </p>
      )}
    </div>
  );
}
