'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import {
  registerCsv,
  toRegisterRows,
  type RegisterRaw,
  type RegisterRow,
} from '@/lib/reports/register';
import { sourceLabel } from '@/lib/contacts/source';
import { Button } from '@/components/ui/button';

/**
 * Admission register: the per-university/intake master list of enrolled
 * students, replacing the office's spreadsheet register. Read-only view over
 * contacts (enrolled = `university` set) with CSV export; corrections happen
 * on the contact itself.
 */
export function AdmissionRegister() {
  const { accountId } = useAuth();
  const [rows, setRows] = useState<RegisterRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [universityFilter, setUniversityFilter] = useState('all');
  const [intakeFilter, setIntakeFilter] = useState('all');

  // setState stays inside the promise callbacks (never synchronously in the
  // effect) — same posture as dashboard/page.tsx and the rule it satisfies.
  // `loading` initializes true, so no synchronous reset is needed.
  const load = useCallback(() => {
    if (!accountId) return;
    createClient()
      .from('contacts')
      .select(
        'id, name, phone, roll_number, university_roll_number, university, intake_year, intake_session, source, source_detail, created_at, conversations(interest_course, interest_mode, interest_updated_at)'
      )
      .eq('account_id', accountId)
      .not('university', 'is', null)
      .order('created_at', { ascending: false })
      .then(({ data, error: qError }) => {
        if (qError) {
          setError(qError.message);
        } else {
          setError(null);
          setRows(toRegisterRows((data ?? []) as unknown as RegisterRaw[]));
        }
        setLoading(false);
      });
  }, [accountId]);

  useEffect(() => {
    load();
  }, [load]);

  const universities = useMemo(
    () => [...new Set((rows ?? []).map((r) => r.university))].sort(),
    [rows]
  );
  const intakes = useMemo(
    () =>
      [...new Set((rows ?? []).map((r) => r.intake).filter(Boolean))].sort(),
    [rows]
  );

  const filtered = useMemo(
    () =>
      (rows ?? []).filter(
        (r) =>
          (universityFilter === 'all' || r.university === universityFilter) &&
          (intakeFilter === 'all' || r.intake === intakeFilter)
      ),
    [rows, universityFilter, intakeFilter]
  );

  function downloadCsv() {
    const blob = new Blob([registerCsv(filtered)], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const uni =
      universityFilter === 'all' ? 'all' : universityFilter.toLowerCase();
    a.download = `kuanli-admission-register-${uni}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={universityFilter}
          onChange={(e) => setUniversityFilter(e.target.value)}
          className="border-border bg-muted text-foreground h-8 rounded border px-2 text-sm"
        >
          <option value="all">All universities</option>
          {universities.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
        <select
          value={intakeFilter}
          onChange={(e) => setIntakeFilter(e.target.value)}
          className="border-border bg-muted text-foreground h-8 rounded border px-2 text-sm"
        >
          <option value="all">All intakes</option>
          {intakes.map((i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </select>
        <span className="text-muted-foreground text-sm">
          {filtered.length} student{filtered.length === 1 ? '' : 's'}
        </span>
        <Button
          variant="outline"
          onClick={downloadCsv}
          disabled={filtered.length === 0}
          className="ml-auto"
        >
          <Download className="mr-2 h-4 w-4" />
          Export CSV
        </Button>
      </div>

      <div className="border-border overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[980px] text-sm">
          <thead className="bg-muted/50 text-muted-foreground text-left text-xs tracking-wider uppercase">
            <tr>
              <th className="px-3 py-2 font-medium">DCId</th>
              <th className="px-3 py-2 font-medium">Univ. roll no</th>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Phone</th>
              <th className="px-3 py-2 font-medium">University</th>
              <th className="px-3 py-2 font-medium">Intake</th>
              <th className="px-3 py-2 font-medium">Course</th>
              <th className="px-3 py-2 font-medium">Mode</th>
              <th className="px-3 py-2 font-medium">Source</th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {loading && (
              <tr>
                <td
                  colSpan={9}
                  className="text-muted-foreground p-6 text-center"
                >
                  Loading…
                </td>
              </tr>
            )}
            {!loading && error && (
              <tr>
                <td colSpan={9} className="p-6 text-center text-red-400">
                  {error}
                </td>
              </tr>
            )}
            {!loading && !error && filtered.length === 0 && (
              <tr>
                <td
                  colSpan={9}
                  className="text-muted-foreground p-6 text-center"
                >
                  No enrolled students match these filters.
                </td>
              </tr>
            )}
            {!loading &&
              !error &&
              filtered.map((r) => (
                <tr key={r.contactId} className="hover:bg-muted/30">
                  <td className="text-foreground px-3 py-2 font-mono text-xs">
                    {r.dcid ?? '—'}
                  </td>
                  <td className="text-foreground px-3 py-2 font-mono text-xs">
                    {r.universityRollNumber ?? (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="text-foreground px-3 py-2">{r.name ?? '—'}</td>
                  <td className="text-foreground px-3 py-2 font-mono text-xs">
                    {r.phone ?? '—'}
                  </td>
                  <td className="text-foreground px-3 py-2">{r.university}</td>
                  <td className="text-foreground px-3 py-2">
                    {r.intake || '—'}
                  </td>
                  <td className="text-foreground px-3 py-2">
                    {r.course ?? '—'}
                  </td>
                  <td className="text-foreground px-3 py-2">{r.mode ?? '—'}</td>
                  <td className="text-foreground px-3 py-2">
                    {sourceLabel(r.source)}
                    {r.sourceDetail ? (
                      <span className="text-muted-foreground">
                        {' '}
                        · {r.sourceDetail}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
