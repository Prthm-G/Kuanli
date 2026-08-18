/** Shapes returned by the `funnel_analytics` RPC (migration 043). */

export interface AnalyticsTotals {
  leads: number;
  enrolled: number;
  lost: number;
  reachedApplication: number;
}

export interface SourceRow {
  source: string;
  leads: number;
  qualified: number;
  counselor: number;
  application: number;
  enrolled: number;
  lost: number;
}

export interface FunnelRow {
  stage: string;
  position: number;
  current: number;
  /** Deals that ever reached this stage. Null for Lost (an exit, not a rung). */
  reached: number | null;
}

export interface InterestRow {
  university: string;
  leads: number;
  application: number;
  enrolled: number;
  lost: number;
}

export interface ResponseTrendRow {
  day: string;
  medianMinutes: number;
  responses: number;
}

export interface FunnelAnalytics {
  totals: AnalyticsTotals;
  sources: SourceRow[];
  funnel: FunnelRow[];
  interest: InterestRow[];
  responseTrend: ResponseTrendRow[];
}
