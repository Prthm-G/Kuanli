import type { DealStatus } from '@/types';

import { isExitDeal, isExitStage } from './closed';
import { closedThisMonth, type StageEvent } from './closed-this-month';

interface StatsStage {
  id: string;
  name: string;
  position: number;
}
interface StatsDeal {
  id: string;
  stage_id: string;
  value: number | string | null;
  status?: DealStatus | null;
}

export interface PipelineStats {
  totalCount: number;
  totalValue: number;
  avgValue: number;
  weightedValue: number;
  /** null until this month's stage events have loaded. */
  wonThisMonth: number | null;
  lostThisMonth: number | null;
}

/**
 * Weighted pipeline value: value × per-stage probability.
 * First stage ≈ 10%, stages interpolate up to 90% before the final stage,
 * final stage (Won) = 100%. `ladder` holds working stages only.
 */
function stageProbability(stageId: string, ladder: StatsStage[]): number {
  const index = ladder.findIndex((s) => s.id === stageId);
  if (index < 0) return 0;
  const n = ladder.length;
  if (n <= 1) return 1;
  if (index === n - 1) return 1;
  const slots = n - 1;
  if (slots <= 1) return 0.1;
  const t = index / (slots - 1);
  return 0.1 + t * (0.9 - 0.1);
}

/**
 * The pipeline header numbers. Lost and Not Interested by stage count as lost
 * (their status stays open), as does a deal marked lost. The probability
 * ladder runs over working stages only, so an exit is never the top rung.
 * The month counts get every stage, so a move into Lost is found.
 */
export function pipelineStats(
  deals: StatsDeal[],
  stages: StatsStage[],
  stageEvents: StageEvent[] | null,
  monthStart: Date
): PipelineStats {
  const ladder = stages
    .filter((s) => !isExitStage(s.name))
    .sort((a, b) => a.position - b.position);
  const stageName = new Map(stages.map((s) => [s.id, s.name]));
  const active = deals.filter(
    (d) =>
      !isExitDeal({ status: d.status, stageName: stageName.get(d.stage_id) })
  );
  const openDeals = active.filter((d) => d.status !== 'won');

  const totalCount = active.length;
  const totalValue = active.reduce((sum, d) => sum + Number(d.value || 0), 0);
  const avgValue = totalCount > 0 ? totalValue / totalCount : 0;
  const weightedValue = openDeals.reduce(
    (sum, d) =>
      sum + Number(d.value || 0) * stageProbability(d.stage_id, ladder),
    0
  );

  // Timed by the move into Enrolled/Lost, not by the deal's last edit.
  const closed = stageEvents
    ? closedThisMonth(deals, stages, stageEvents, monthStart)
    : null;

  return {
    totalCount,
    totalValue,
    avgValue,
    weightedValue,
    wonThisMonth: closed?.won ?? null,
    lostThisMonth: closed?.lost ?? null,
  };
}
