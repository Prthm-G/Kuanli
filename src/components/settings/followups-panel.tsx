'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';

interface Rung {
  id: string;
  rung_order: number;
  delay_hours: number;
  body: string | null;
  template_name: string | null;
  active: boolean;
}

function describeDelay(hours: number): string {
  if (hours < 24) return `${hours}h of silence`;
  return `${Math.round(hours / 24)} days of silence`;
}

/**
 * Follow-up ladder settings (migration 044). Read-only list of the account's
 * rungs with an active toggle — the toggle is the pause switch for each rung.
 * Rung bodies/templates are deliberately not editable here yet: free-form
 * copy changes are low-risk but template rungs must reference an APPROVED
 * Meta template, and editing that safely needs the template picker. SQL or a
 * later iteration handles copy changes.
 */
export function FollowupsPanel() {
  const { accountId, accountRole } = useAuth();
  const [rungs, setRungs] = useState<Rung[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canEdit = accountRole === 'owner' || accountRole === 'admin';

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    void (async () => {
      const { data, error: err } = await createClient()
        .from('follow_up_rungs')
        .select('id, rung_order, delay_hours, body, template_name, active')
        .eq('account_id', accountId)
        .order('rung_order');
      if (cancelled) return;
      if (err) setError(err.message);
      else setRungs(data as Rung[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  async function toggle(rung: Rung, next: boolean) {
    // Optimistic flip; revert on error.
    setRungs((rs) =>
      rs ? rs.map((r) => (r.id === rung.id ? { ...r, active: next } : r)) : rs
    );
    const { error: err } = await createClient()
      .from('follow_up_rungs')
      .update({ active: next })
      .eq('id', rung.id);
    if (err) {
      setRungs((rs) =>
        rs
          ? rs.map((r) =>
              r.id === rung.id ? { ...r, active: rung.active } : r
            )
          : rs
      );
      toast.error(`Could not update: ${err.message}`);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-foreground text-lg font-semibold">Follow-ups</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Automatic re-engagement for leads that go quiet. Each rung fires at
          most once per silence spell, at most one follow-up per lead per 24
          hours, and the ladder stops the moment the lead replies, a counsellor
          takes over, or the application starts.
        </p>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="space-y-3">
        {rungs === null && !error && (
          <p className="text-muted-foreground text-sm">Loading…</p>
        )}
        {rungs?.map((r) => (
          <div
            key={r.id}
            className="border-border bg-card flex items-start justify-between gap-4 rounded-lg border p-4"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-foreground text-sm font-medium">
                  Rung {r.rung_order} · after {describeDelay(r.delay_hours)}
                </span>
                {r.template_name ? (
                  <Badge variant="outline">Template: {r.template_name}</Badge>
                ) : (
                  <Badge variant="outline">In-window message</Badge>
                )}
              </div>
              {r.body && (
                <p className="text-muted-foreground mt-1 line-clamp-2 text-sm">
                  {r.body}
                </p>
              )}
              {r.template_name && (
                <p className="text-muted-foreground mt-1 text-sm">
                  Sends the approved Meta template. Keep this rung off until the
                  template exists and is approved.
                </p>
              )}
            </div>
            <Switch
              checked={r.active}
              disabled={!canEdit}
              onCheckedChange={(next) => void toggle(r, next)}
              aria-label={`Rung ${r.rung_order} active`}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
