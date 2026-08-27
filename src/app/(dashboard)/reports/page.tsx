'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarDays, Download, Search } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { loadEodReport } from '@/lib/reports/queries';
import {
  resolveRange,
  describeRange,
  type EodPeriod,
} from '@/lib/reports/period';
import {
  isPlaceholderRoll,
  type EodReport,
  type EodRow,
} from '@/lib/reports/types';
import { Button } from '@/components/ui/button';
import { AssignRollNumberDialog } from '@/components/reports/assign-roll-number-dialog';
import { AdmissionRegister } from '@/components/reports/admission-register';

const TABS: { key: EodPeriod; label: string }[] = [
  { key: 'day', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
];

function toCsv(rows: EodRow[]): string {
  const head = [
    'Started',
    'Name',
    'Phone',
    'University',
    'Mode',
    'Course',
    'Roll number',
    'Status',
  ];
  // Quote every field and double interior quotes: names and courses contain
  // commas often enough that an unquoted CSV silently shifts columns.
  const esc = (v: string | null) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = rows.map((r) =>
    [
      new Date(r.createdAt).toLocaleString(),
      r.name,
      r.phone,
      r.university,
      r.mode,
      r.course,
      isPlaceholderRoll(r.rollNumber) ? '' : r.rollNumber,
      r.status,
    ]
      .map(esc)
      .join(',')
  );
  return [head.map(esc).join(','), ...lines].join('\n');
}

/** Two report surfaces on one page, same local-tab pattern as /follow-ups:
 *  the EOD activity report, and the admission register (the office's old
 *  spreadsheet master list of enrolled students). */
type ReportView = 'eod' | 'register';

export default function ReportsPage() {
  const { accountId } = useAuth();
  const [view, setView] = useState<ReportView>('eod');
  const [period, setPeriod] = useState<EodPeriod>('day');
  const [report, setReport] = useState<EodReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<EodRow | null>(null);
  const [eodSearch, setEodSearch] = useState('');
  const router = useRouter();

  const rangeLabel = useMemo(
    () => describeRange(resolveRange(period)),
    [period]
  );

  // Client-side filter so a counsellor can find one student in the day's
  // conversations without scrolling. Matches name, phone, course, university,
  // and roll number.
  const filteredRows = useMemo(() => {
    const q = eodSearch.trim().toLowerCase();
    const rows = report?.rows ?? [];
    if (!q) return rows;
    return rows.filter((r) =>
      [r.name, r.phone, r.course, r.university, r.rollNumber].some((v) =>
        (v ?? '').toLowerCase().includes(q)
      )
    );
  }, [report, eodSearch]);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    setError(null);
    try {
      setReport(await loadEodReport(createClient(), accountId, period));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the report');
    } finally {
      setLoading(false);
    }
  }, [accountId, period]);

  useEffect(() => {
    void load();
  }, [load]);

  function downloadCsv() {
    if (!report) return;
    const blob = new Blob([toCsv(report.rows)], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
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
          <h1 className="text-foreground text-xl font-semibold">
            {view === 'eod' ? 'EOD report' : 'Admission register'}
          </h1>
          <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
            <CalendarDays className="h-3.5 w-3.5" />
            {view === 'eod'
              ? `New conversations · ${rangeLabel}`
              : 'Enrolled students by university and intake'}
          </p>
        </div>
        {view === 'eod' && (
          <Button
            variant="outline"
            onClick={downloadCsv}
            disabled={!report || report.rows.length === 0}
          >
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        )}
      </div>

      <div className="border-border bg-muted/40 flex gap-1 rounded-lg border p-1">
        {(
          [
            { key: 'eod', label: 'EOD report' },
            { key: 'register', label: 'Admission register' },
          ] as { key: ReportView; label: string }[]
        ).map((t) => (
          <button
            key={t.key}
            onClick={() => setView(t.key)}
            className={
              'flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ' +
              (view === t.key
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground')
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {view === 'register' && <AdmissionRegister />}

      {view === 'eod' && (
        <div className="border-border bg-muted/40 flex gap-1 rounded-lg border p-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setPeriod(t.key)}
              className={
                'flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ' +
                (period === t.key
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground')
              }
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {view === 'eod' && report && s && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="New conversations" value={s.total} />
          <Stat label="University known" value={s.withUniversity} />
          <Stat label="Course known" value={s.withCourse} />
          <Stat label="Roll number issued" value={s.enrolled} />
          <Stat label="Follow-ups logged" value={report.followups.logged} />
          <Stat label="Still overdue" value={report.followups.overdue} />
        </div>
      )}

      {view === 'eod' && (
        <div className="relative max-w-sm">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <input
            type="search"
            value={eodSearch}
            onChange={(e) => setEodSearch(e.target.value)}
            placeholder="Search name, phone, course, roll…"
            aria-label="Search EOD rows"
            className="border-input focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-lg border bg-transparent pr-2.5 pl-8 text-sm outline-none transition-colors focus-visible:ring-3 dark:bg-input/30"
          />
        </div>
      )}

      {view === 'eod' && (
        <div className="border-border overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-muted/50 text-muted-foreground text-left text-xs tracking-wider uppercase">
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
            <tbody className="divide-border divide-y">
              {loading && (
                <tr>
                  <td
                    colSpan={8}
                    className="text-muted-foreground p-6 text-center"
                  >
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
              {!loading && !error && filteredRows.length === 0 && (
                <tr>
                  <td
                    colSpan={8}
                    className="text-muted-foreground p-6 text-center"
                  >
                    {eodSearch.trim()
                      ? 'No rows match your search.'
                      : 'No new conversations in this period.'}
                  </td>
                </tr>
              )}
              {!loading &&
                !error &&
                filteredRows.map((r) => (
                  <tr
                    key={r.conversationId}
                    onClick={() =>
                      r.contactId &&
                      router.push(`/contacts?contact=${r.contactId}`)
                    }
                    className={`hover:bg-muted/30 ${r.contactId ? 'cursor-pointer' : ''}`}
                  >
                    <Td>{new Date(r.createdAt).toLocaleString()}</Td>
                    <Td>{r.name || <Dash />}</Td>
                    <Td className="font-mono text-xs">{r.phone || <Dash />}</Td>
                    <Td>{r.university || <Dash />}</Td>
                    <Td>{r.mode || <Dash />}</Td>
                    <Td>{r.course || <Dash />}</Td>
                    <Td className="font-mono text-xs">
                      {isPlaceholderRoll(r.rollNumber) ? (
                        <Dash />
                      ) : (
                        r.rollNumber
                      )}
                    </Td>
                    <Td>
                      {isPlaceholderRoll(r.rollNumber) && r.contactId && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={(e) => {
                            e.stopPropagation();
                            setAssigning(r);
                          }}
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
      )}

      {/* Keyed on the row so switching leads remounts the dialog with fresh
          state instead of syncing props into state inside it. */}
      <AssignRollNumberDialog
        key={assigning?.conversationId ?? 'none'}
        row={assigning}
        onClose={() => setAssigning(null)}
        onDone={load}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-border bg-card rounded-lg border p-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="text-foreground mt-0.5 text-2xl font-semibold">{value}</p>
    </div>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="px-3 py-2 font-medium">{children}</th>;
}

function Td({
  children,
  className = '',
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={`text-foreground px-3 py-2 ${className}`}>{children}</td>
  );
}

function Dash() {
  return <span className="text-muted-foreground">—</span>;
}
