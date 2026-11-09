import type { DealStatus } from '@/types';

/**
 * The exit stages. A deal there is closed even though its `status` stays
 * 'open': the lifecycle sweep moves deals to Lost by stage, and the 093 trigger
 * moves them to Not Interested by stage, and neither touches `status`. The
 * names are the ones n8n and the SQL functions use; they are never renamed.
 */
export const EXIT_STAGES = ['Lost', 'Not Interested'] as const;

export function isExitStage(name: string | null | undefined): boolean {
  return !!name && (EXIT_STAGES as readonly string[]).includes(name);
}

/** Closed as lost: marked lost by hand, or sitting in an exit stage. */
export function isExitDeal(deal: {
  status?: DealStatus | null;
  stageName?: string | null;
}): boolean {
  return deal.status === 'lost' || isExitStage(deal.stageName);
}

/** Dashboard "open deals": status-open rows minus those in an exit stage. */
export function openDealsSummary(
  rows: { value: number | null; stage: { name: string } | null }[]
): { count: number; value: number } {
  const open = rows.filter((d) => !isExitStage(d.stage?.name));
  return {
    count: open.length,
    value: open.reduce((sum, d) => sum + (d.value ?? 0), 0),
  };
}
