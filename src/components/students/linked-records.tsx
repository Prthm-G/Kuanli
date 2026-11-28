'use client';

import { useEffect, useState } from 'react';
import { Link2, Search } from 'lucide-react';
import { toast } from 'sonner';

import { createClient } from '@/lib/supabase/client';
import { searchStudents, type StudentHit } from '@/lib/contacts/student-search';
import {
  linkStudents,
  markNotSameStudent,
  NotSameStudentError,
  recordLabel,
  unlinkStudents,
  type StudentRecord,
} from '@/lib/students/queries';
import { useOpenStudent } from './student-drawer';

interface LinkedRecordsProps {
  accountId: string;
  userId: string;
  contactId: string;
  records: StudentRecord[];
  canEdit: boolean;
  onChanged: () => void;
}

/** Other records of this student: same number (auto) or linked by hand. No merge; only reads widen (migration 106). */
export function LinkedRecords({
  accountId,
  userId,
  contactId,
  records,
  canEdit,
  onChanged,
}: LinkedRecordsProps) {
  const openStudent = useOpenStudent();
  const others = records.filter((r) => r.contactId !== contactId);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<StudentHit[]>([]);

  useEffect(() => {
    const term = q.trim();
    let cancelled = false;
    const handle = setTimeout(() => {
      if (term.length < 2) {
        setHits([]);
        return;
      }
      searchStudents(createClient(), accountId, term)
        .then((rows) => {
          if (!cancelled)
            setHits(
              rows.filter(
                (h) => !records.some((r) => r.contactId === h.contactId)
              )
            );
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [q, accountId, records]);

  async function run(
    action: () => Promise<void>,
    done: string,
    failed: string
  ) {
    setBusy(true);
    try {
      await action();
      toast.success(done);
      setConfirming(null);
      setSearching(false);
      setQ('');
      onChanged();
    } catch (e) {
      toast.error(e instanceof NotSameStudentError ? e.message : failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs font-medium tracking-wider uppercase">
        <Link2 className="h-3 w-3" /> Same student
      </div>
      {others.length === 0 && (
        <p className="text-muted-foreground px-1 text-xs">No other records.</p>
      )}
      {others.map((r) => (
        <div
          key={r.contactId}
          className="bg-muted flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-xs"
        >
          <button
            type="button"
            onClick={() => openStudent(r.contactId)}
            className="text-foreground min-w-0 flex-1 truncate text-left font-medium hover:underline"
          >
            {recordLabel(r)}
          </button>
          <span className="text-muted-foreground">
            {r.via === 'phone' ? 'Same number' : 'Linked'}
          </span>
          {canEdit &&
            (confirming === r.contactId ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  className="font-medium text-red-400"
                  onClick={() =>
                    void run(
                      () =>
                        r.via === 'link' && r.linkId
                          ? unlinkStudents(createClient(), r.linkId)
                          : markNotSameStudent(
                              createClient(),
                              accountId,
                              userId,
                              contactId,
                              r.contactId
                            ),
                      r.via === 'link'
                        ? 'Unlinked'
                        : 'Marked as a different student',
                      r.via === 'link' ? 'Could not unlink' : 'Could not save'
                    )
                  }
                >
                  Confirm
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setConfirming(null)}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setConfirming(r.contactId)}
              >
                {r.via === 'link' ? 'Unlink' : 'Not the same student'}
              </button>
            ))}
        </div>
      ))}
      {canEdit && !searching && (
        <button
          type="button"
          onClick={() => setSearching(true)}
          className="border-border text-foreground hover:bg-muted/50 inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium"
        >
          Link as same student
        </button>
      )}
      {canEdit && searching && (
        <div className="space-y-1">
          <div className="relative">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
            <input
              autoFocus
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, phone, provisional ID"
              aria-label="Find the other record"
              className="border-input h-8 w-full rounded-md border bg-transparent pr-2 pl-7 text-xs outline-none"
            />
          </div>
          {hits.map((h) => (
            <button
              key={h.contactId}
              type="button"
              disabled={busy}
              onClick={() =>
                void run(
                  () =>
                    linkStudents(
                      createClient(),
                      accountId,
                      userId,
                      contactId,
                      h.contactId
                    ),
                  'Linked',
                  'Could not link'
                )
              }
              className="hover:bg-muted flex w-full flex-col items-start rounded px-2 py-1 text-left text-xs"
            >
              <span className="text-foreground font-medium">
                {recordLabel({ name: h.name, phone: h.phone })}
              </span>
              <span className="text-muted-foreground">
                {h.university ?? ''}
              </span>
            </button>
          ))}
          <button
            type="button"
            className="text-muted-foreground text-xs"
            onClick={() => {
              setSearching(false);
              setQ('');
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
