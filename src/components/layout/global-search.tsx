'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import {
  matchLabel,
  searchStudents,
  type StudentHit,
} from '@/lib/contacts/student-search';

/** Masked phone for the result row: the last 4 digits only. */
function maskPhone(phone: string | null): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits ? `…${digits.slice(-4)}` : '';
}

/** The matched value, shown only for ID-type matches. */
function matchedValue(h: StudentHit): string | null {
  switch (h.matched) {
    case 'provisional_id':
      return h.provisionalAppId;
    case 'university_app_number':
      return h.universityAppNumber;
    case 'registration_number':
      return h.registrationNumber;
    default:
      return null;
  }
}

/**
 * Header-wide student lookup. Finds any contact in the account by name, phone,
 * email, provisional ID, university application number, registration or roll
 * number (the `search_students` RPC) and jumps to it via the
 * /contacts?contact=<id> deep link, which opens that contact's detail drawer.
 * Read-only; navigation only.
 */
export function GlobalSearch() {
  const { accountId } = useAuth();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<StudentHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // Debounced query. The RPC takes the raw term, so only trim it.
  useEffect(() => {
    const term = query.trim();
    // All setState lives in the timeout callback (never synchronously in the
    // effect body) to satisfy react-hooks/set-state-in-effect, and the timeout
    // doubles as the debounce.
    if (!accountId || term.length < 2) {
      const clear = setTimeout(() => {
        setHits([]);
        setLoading(false);
      }, 0);
      return () => clearTimeout(clear);
    }
    const handle = setTimeout(() => {
      setLoading(true);
      searchStudents(createClient(), accountId, term)
        .then((rows) => setHits(rows))
        .catch((error: Error) => {
          console.error('Search failed:', error.message);
          setHits([]);
        })
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(handle);
  }, [query, accountId]);

  // Close the results when focus leaves the whole widget.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  function go(id: string) {
    setOpen(false);
    setQuery('');
    setHits([]);
    router.push(`/contacts?contact=${id}`);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      setOpen(false);
      (e.target as HTMLInputElement).blur();
    } else if (e.key === 'Enter' && hits.length > 0) {
      go(hits[0].contactId);
    }
  }

  return (
    <div ref={boxRef} className="relative hidden w-full max-w-xs sm:block">
      <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
      <input
        type="search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="Search name, phone, provisional ID"
        aria-label="Search leads"
        className="border-input bg-transparent focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-lg border pr-2.5 pl-8 text-sm outline-none transition-colors focus-visible:ring-3 dark:bg-input/30"
      />

      {open && query.trim().length >= 2 && (
        <div className="border-border bg-popover absolute top-full left-0 z-50 mt-1 w-full min-w-72 overflow-hidden rounded-lg border shadow-md ring-1 ring-foreground/10">
          {loading && hits.length === 0 && (
            <p className="text-muted-foreground px-3 py-3 text-sm">Searching…</p>
          )}
          {!loading && hits.length === 0 && (
            <p className="text-muted-foreground px-3 py-3 text-sm">
              No leads match.
            </p>
          )}
          {hits.map((h) => {
            const value = matchedValue(h);
            const phone = maskPhone(h.phone);
            return (
              <button
                key={h.contactId}
                type="button"
                onClick={() => go(h.contactId)}
                className="hover:bg-accent focus:bg-accent flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left outline-none"
              >
                <span className="text-foreground text-sm font-medium">
                  {h.name || phone || 'Unnamed lead'}
                </span>
                <span className="text-muted-foreground truncate text-xs">
                  {[
                    h.name ? phone : null,
                    `${matchLabel(h.matched)}${value ? `: ${value}` : ''}`,
                    h.university,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
