"use client";

import { useMemo } from "react";
import type { Deal, PipelineStage } from "@/types";
import {
  DollarSign,
  TrendingUp,
  Target,
  BarChart3,
  Trophy,
  XCircle,
  Info,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/use-auth";
import { canViewMoney } from "@/lib/auth/roles";
import { formatCurrency } from "@/lib/currency";
import {
  startOfMonth,
  type StageEvent,
} from "@/lib/pipelines/closed-this-month";
import { pipelineStats } from "@/lib/pipelines/stats";

interface PipelineAnalyticsProps {
  stages: PipelineStage[];
  deals: Deal[];
  /** This month's moves into Enrolled/Lost (deal_stage_events); null while
   *  loading or after a failed read. */
  stageEvents: StageEvent[] | null;
}

export function PipelineAnalytics({ stages, deals, stageEvents }: PipelineAnalyticsProps) {
  const { defaultCurrency, accountRole } = useAuth();
  // Counsellors get the deal count only: no values, no won/lost tally (KB-SP3B-MONEY).
  const showMoney = canViewMoney(accountRole);
  // Worked out in lib/pipelines/stats.ts, where it is tested.
  const stats = useMemo(
    () => pipelineStats(deals, stages, stageEvents, startOfMonth()),
    [deals, stages, stageEvents],
  );

  return (
    <TooltipProvider>
      <div className="grid grid-cols-2 gap-3 rounded-xl border border-border bg-card/60 p-4 sm:grid-cols-3 xl:grid-cols-6">
        <Metric
          icon={<BarChart3 className="h-4 w-4 text-muted-foreground" />}
          label="Total Deals"
          value={String(stats.totalCount)}
          tooltip="Count of every deal in this pipeline that isn't in the Lost or Not Interested stage or marked lost. Enrolled deals are still included."
        />
        {showMoney && (
          <>
            <Metric
              icon={<DollarSign className="h-4 w-4 text-primary" />}
              label="Pipeline Value"
              value={formatCurrency(stats.totalValue, defaultCurrency)}
              tooltip="Sum of the dollar values of all deals in this pipeline, excluding deals in the Lost or Not Interested stage or marked lost."
            />
            <Metric
              icon={<Target className="h-4 w-4 text-blue-400" />}
              label="Avg Deal Size"
              value={formatCurrency(stats.avgValue, defaultCurrency)}
              tooltip="Pipeline Value divided by Total Deals — the average value of a single non-lost deal."
            />
            <Metric
              icon={<TrendingUp className="h-4 w-4 text-purple-400" />}
              label="Weighted Value"
              value={formatCurrency(stats.weightedValue, defaultCurrency)}
              tooltip="Expected revenue: each open deal's value × its stage probability. First stage ≈ 10%, stages progress up to 90%, Won = 100%. Lost and Not Interested deals are excluded."
            />
            <Metric
              icon={<Trophy className="h-4 w-4 text-primary" />}
              label="Won This Month"
              value={stats.wonThisMonth === null ? "…" : String(stats.wonThisMonth)}
              tooltip="Deals moved into Enrolled since the first day of this month (India time), timed by the stage move, and still there."
            />
            <Metric
              icon={<XCircle className="h-4 w-4 text-red-400" />}
              label="Lost This Month"
              value={stats.lostThisMonth === null ? "…" : String(stats.lostThisMonth)}
              tooltip="Deals moved into Lost since the first day of this month (India time), timed by the stage move, and still there."
            />
          </>
        )}
      </div>
    </TooltipProvider>
  );
}

function Metric({
  icon,
  label,
  value,
  tooltip,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tooltip: string;
}) {
  return (
    <div className="rounded-lg bg-muted/50 p-3">
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {icon}
        <span>{label}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`How ${label} is calculated`}
                className="ml-auto text-muted-foreground hover:text-foreground focus:outline-none"
              />
            }
          >
            <Info className="h-3 w-3" />
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-left">
            {tooltip}
          </TooltipContent>
        </Tooltip>
      </div>
      <p className="mt-1 text-base font-semibold text-foreground">{value}</p>
    </div>
  );
}
