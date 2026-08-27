"use client";

import type { Deal, PipelineStage } from "@/types";
import type { QueueLead } from "@/lib/queue/types";
import { Calendar, Check, X } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface DealCardProps {
  deal: Deal;
  stage: PipelineStage | null;
  onEdit: (deal: Deal) => void;
  isOverlay?: boolean;
  /** Queue insight for this contact (score / awaiting / interest), optional. */
  insight?: QueueLead;
  /** All stages in this pipeline — powers the no-drag "Move to stage" picker. */
  stages?: PipelineStage[];
  /** Advance/move this deal to another stage without dragging. */
  onMoveToStage?: (dealId: string, stageId: string) => void;
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function waitLabel(lastCustomerAt: string | null): string {
  if (!lastCustomerAt) return "";
  const hours = Math.max(
    0,
    (Date.now() - new Date(lastCustomerAt).getTime()) / 3_600_000,
  );
  if (hours < 1) return "now";
  if (hours < 24) return `${Math.floor(hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}

function initials(name?: string, fallback?: string) {
  const source = (name || fallback || "?").trim();
  if (!source) return "?";
  return source.charAt(0).toUpperCase();
}

export function DealCard({ deal, stage, onEdit, isOverlay, insight, stages, onMoveToStage }: DealCardProps) {
  const contactLabel = deal.contact?.name || deal.contact?.phone || "No contact";
  const assigneeLabel = deal.assignee?.full_name || null;

  return (
    <div
      className={`group relative w-full rounded-xl border border-border/50 bg-muted/70 shadow-sm transition-all ${
        isOverlay
          ? "shadow-xl"
          : "hover:-translate-y-0.5 hover:border-border hover:bg-muted hover:shadow-lg"
      }`}
    >
      {/* 4px left accent bar using stage color */}
      <span
        aria-hidden
        className="absolute left-0 top-0 h-full w-1 rounded-l-xl"
        style={{ backgroundColor: stage?.color ?? "#94a3b8" }}
      />

      <button
        type="button"
        onClick={(e) => {
          // `onClick` still fires after a non-drag tap because the PointerSensor
          // requires 5px movement before it counts as a drag.
          if (isOverlay) return;
          e.stopPropagation();
          onEdit(deal);
        }}
        className="block w-full cursor-pointer rounded-xl py-3 pr-3 pl-4 text-left"
      >
      <div className="flex items-start justify-between gap-2">
        <h4 className="flex-1 text-sm font-semibold leading-snug text-foreground break-words">
          {deal.title}
        </h4>
        {deal.status === "won" && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
            <Check className="h-3 w-3" />
            Won
          </span>
        )}
        {deal.status === "lost" && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-400">
            <X className="h-3 w-3" />
            Lost
          </span>
        )}
      </div>

      {/* Contact row */}
      <div className="mt-2 flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-foreground">
          {initials(deal.contact?.name, deal.contact?.phone)}
        </span>
        <span className="truncate text-xs text-muted-foreground">{contactLabel}</span>
      </div>

      <div className="mt-2 flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-bold text-primary">
            {deal.contact?.roll_number || "No DCId"}
          </span>
          <span className="text-xs text-muted-foreground font-medium">
            {deal.contact?.university ? `${deal.contact.university} • 20${deal.contact.intake_year}${deal.contact.intake_session}` : "Course Pending"}
          </span>
        </div>
        {deal.expected_close_date && (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Calendar className="h-3 w-3" />
            {formatDate(deal.expected_close_date)}
          </span>
        )}
      </div>

      {insight && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span
            className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary"
            title={`Queue score ${insight.score.total}`}
          >
            {insight.score.total}
          </span>
          {insight.score.isAwaitingReply && (
            <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-500">
              awaiting {waitLabel(insight.lastCustomerAt)}
            </span>
          )}
          {(insight.course || insight.specialization) && (
            <span className="truncate text-[10px] text-muted-foreground">
              {[insight.course, insight.specialization]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
        </div>
      )}

      {assigneeLabel && (
        <div className="mt-2 flex items-center justify-end">
          <span
            title={assigneeLabel}
            className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary"
          >
            {initials(assigneeLabel)}
          </span>
        </div>
      )}
      </button>

      {!isOverlay && onMoveToStage && stages && stages.length > 0 && (
        // The card is wrapped in dnd-kit drag listeners and an edit-on-click
        // button; stop pointer/click here so the picker never starts a drag or
        // opens the edit form.
        <div
          className="px-4 pb-3"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <Select
            value={deal.stage_id}
            onValueChange={(value) => {
              const next = String(value);
              if (next && next !== deal.stage_id) onMoveToStage(deal.id, next);
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full bg-background/60"
              aria-label="Move to stage"
            >
              <span className="mr-1 text-xs text-muted-foreground">Stage:</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {stages.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}
