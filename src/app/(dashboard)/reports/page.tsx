"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, Download } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { loadEodReport } from "@/lib/reports/queries";
import { resolveRange, describeRange, type EodPeriod } from "@/lib/reports/period";
import { isPlaceholderRoll, type EodReport, type EodRow } from "@/lib/reports/types";
import { Button } from "@/components/ui/button";
import { AssignRollNumberDialog } from "@/components/reports/assign-roll-number-dialog";

const TABS: { key: EodPeriod; label: string }[] = [
  { key: "day", label: "Today" },
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
];

function toCsv(rows: EodRow[]): string {
  const head = [
    "Started",
    "Name",
    "Phone",
    "University",
    "Mode",
    "Course",
    "Roll number",
    "Status",
  ];
  // Quote every field and double interior quotes: names and courses contain
  // commas often enough that an unquoted CSV silently shifts columns.
  const esc = (v: string | null) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = rows.map((r) =>
    [
      new Date(r.createdAt).toLocaleString(),
      r.name,
      r.phone,
      r.university,
      r.mode,
      r.course,
      isPlaceholderRoll(r.rollNumber) ? "" : r.rollNumber,
      r.status,
    ]
      .map(esc)
      .join(","),
  );
  return [head.map(esc).join(","), ...lines].join("\n");
}

export default function ReportsPage() {
  const { accountId } = useAuth();
  const [period, setPeriod] = useState<EodPeriod>("day");
  const [report, setReport] = useState<EodReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<EodRow | null>(null);

  const rangeLabel = useMemo(() => describeRange(resolveRange(period)), [period]);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    setError(null);
    try {
      setReport(await loadEodReport(createClient(), accountId, period));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the report");
    } finally {
      setLoading(false);
    }
  }, [accountId, period]);

  useEffect(() => {
    void load();
  }, [load]);

  function downloadCsv() {
    if (!report) return;
    const blob = new Blob([toCsv(report.rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `kuanli-eod-${period}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const s = report?.summary;

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">EOD report</h1>
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <CalendarDays className="h-3.5 w-3.5" />
            New conversations · {rangeLabel}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={downloadCsv}
          disabled={!report || report.rows.length === 0}
        >
          <Download className="mr-2 h-4 w-4" />
          Export CSV
        </Button>
      </div>

      <div className="flex gap-1 rounded-lg border border-border bg-muted/40 p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setPeriod(t.key)}
            className={
              "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
              (period === t.key
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {report && s && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="New conversations" value={s.total} />
          <Stat label="University known" value={s.withUniversity} />
          <Stat label="Course known" value={s.withCourse} />
          <Stat label="Roll number issued" value={s.enrolled} />
          <Stat label="Follow-ups logged" value={report.followups.logged} />
          <Stat label="Still overdue" value={report.followups.overdue} />
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <Th>Started</Th>
              <Th>Name</Th>
              <Th>Phone</Th>
              <Th>University</Th>
              <Th>Mode</Th>
              <Th>Course</Th>
              <Th>Roll number</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading && (
              <tr>
                <td colSpan={8} className="p-6 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && error && (
              <tr>
                <td colSpan={8} className="p-6 text-center text-red-400">
                  {error}
                </td>
              </tr>
            )}
            {!loading && !error && report?.rows.length === 0 && (
              <tr>
                <td colSpan={8} className="p-6 text-center text-muted-foreground">
                  No new conversations in this period.
                </td>
              </tr>
            )}
            {!loading &&
              !error &&
              report?.rows.map((r) => (
                <tr key={r.conversationId} className="hover:bg-muted/30">
                  <Td>{new Date(r.createdAt).toLocaleString()}</Td>
                  <Td>{r.name || <Dash />}</Td>
                  <Td className="font-mono text-xs">{r.phone || <Dash />}</Td>
                  <Td>{r.university || <Dash />}</Td>
                  <Td>{r.mode || <Dash />}</Td>
                  <Td>{r.course || <Dash />}</Td>
                  <Td className="font-mono text-xs">
                    {isPlaceholderRoll(r.rollNumber) ? <Dash /> : r.rollNumber}
                  </Td>
                  <Td>
                    {isPlaceholderRoll(r.rollNumber) && r.contactId && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setAssigning(r)}
                      >
                        Assign roll number
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {/* Keyed on the row so switching leads remounts the dialog with fresh
          state instead of syncing props into state inside it. */}
      <AssignRollNumberDialog
        key={assigning?.conversationId ?? "none"}
        row={assigning}
        onClose={() => setAssigning(null)}
        onDone={load}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-2xl font-semibold text-foreground">{value}</p>
    </div>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="px-3 py-2 font-medium">{children}</th>;
}

function Td({
  children,
  className = "",
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-3 py-2 text-foreground ${className}`}>{children}</td>;
}

function Dash() {
  return <span className="text-muted-foreground">—</span>;
}
