'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { formatCurrency } from '@/lib/currency';
import { loadFeeTemplates } from '@/lib/payments/queries';
import {
  OPTION_LABEL,
  TERM_NOUN,
  type FeeTemplate,
} from '@/lib/payments/types';
import { Switch } from '@/components/ui/switch';

/**
 * Fee templates (migration 056): what each programme costs, per university,
 * mode and payment option.
 *
 * Read-only apart from the active toggle, deliberately and for the same reason
 * as the follow-up ladder panel next door: these numbers are quoted to
 * students and remitted to universities, and the seeded set came from
 * brochures and fee sheets that were reviewed before they were loaded. Editing
 * amounts inline invites a typo into a figure nobody re-checks. The toggle is
 * the safe control — it retires a template from the picker without touching
 * any student's existing plan, which snapshots its own amounts.
 */
export function FeeTemplatesPanel() {
  const { accountId, accountRole } = useAuth();
  const [templates, setTemplates] = useState<FeeTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const canEdit = accountRole === 'owner' || accountRole === 'admin';

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;

    void (async () => {
      try {
        const rows = await loadFeeTemplates(createClient(), accountId, {
          includeInactive: true,
        });
        if (!cancelled) {
          setTemplates(rows);
          setError(null);
        }
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : 'Could not load fee plans');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [accountId, reload]);

  const grouped = useMemo(() => {
    const map = new Map<string, FeeTemplate[]>();
    for (const t of templates ?? []) {
      const key = `${t.university} · ${t.mode}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [templates]);

  async function toggle(t: FeeTemplate, active: boolean) {
    setBusy(t.id);
    const { error: err } = await createClient()
      .from('fee_templates')
      .update({ active })
      .eq('id', t.id);
    setBusy(null);
    if (err) toast.error(`Could not update: ${err.message}`);
    else setReload((k) => k + 1);
  }

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!templates)
    return <p className="text-muted-foreground text-sm">Loading…</p>;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-foreground text-lg font-semibold">Fee plans</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          What each programme costs. A plan applied to a student snapshots these
          amounts, so retiring or replacing a plan here never changes what an
          existing student owes.
        </p>
      </div>

      {templates.length === 0 && (
        <p className="text-muted-foreground text-sm">
          No fee plans yet. They are seeded from the university brochures and
          fee sheets; ask whoever runs the migrations to load them.
        </p>
      )}

      {grouped.map(([group, list]) => (
        <section key={group}>
          <h3 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wider uppercase">
            {group}
          </h3>
          <div className="border-border divide-border divide-y rounded-lg border">
            {list.map((t) => (
              <div
                key={t.id}
                className="flex items-center justify-between gap-3 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <div className="text-foreground text-sm">
                    {[t.program, t.specialization].filter(Boolean).join(' · ')}
                    <span className="text-muted-foreground ml-2 text-xs">
                      {OPTION_LABEL[t.paymentOption]}
                      {t.variant && ` · ${t.variant}`}
                    </span>
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {t.programmeFee != null && t.termCount != null && (
                      <>
                        {formatCurrency(t.programmeFee, t.currency)} ×{' '}
                        {t.termCount} {TERM_NOUN[t.paymentOption]}
                        {t.termCount === 1 ? '' : 's'}
                      </>
                    )}
                    {t.examFee != null &&
                      ` · exam ${formatCurrency(t.examFee, t.currency)}`}
                    {t.applicationFee != null &&
                      ` · application ${formatCurrency(t.applicationFee, t.currency)}`}
                    {t.totalFee != null && (
                      <span className="text-foreground">
                        {' '}
                        · total {formatCurrency(t.totalFee, t.currency)}
                      </span>
                    )}
                    {t.listDiscountPct != null &&
                      ` · includes ${t.listDiscountPct}% discount`}
                  </div>
                  {t.source && (
                    <div className="text-muted-foreground/70 truncate text-[11px]">
                      {t.source}
                    </div>
                  )}
                </div>
                <Switch
                  checked={t.active}
                  disabled={!canEdit || busy === t.id}
                  onCheckedChange={(v) => void toggle(t, v)}
                  aria-label={`${t.active ? 'Retire' : 'Activate'} ${t.program} ${OPTION_LABEL[t.paymentOption]}`}
                />
              </div>
            ))}
          </div>
        </section>
      ))}

      {!canEdit && templates.length > 0 && (
        <p className="text-muted-foreground text-xs">
          Only an owner or admin can retire a fee plan.
        </p>
      )}
    </div>
  );
}
