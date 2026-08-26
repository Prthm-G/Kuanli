'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';

interface Hit {
  id: string;
  name: string | null;
  phone: string | null;
  roll_number: string | null;
  university_roll_number: string | null;
  university: string | null;
}

/**
 * Header-wide lead lookup. Finds any contact in the account by name, phone, or
 * either roll number and jumps to it via the /contacts?contact=<id> deep link,
 * which opens that contact's detail drawer. Read-only; navigation only.
 */
export function GlobalSearch() {
  const { accountId } = useAuth();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // Debounced query. PostgREST `or()` treats commas and parens as syntax, so
  // strip anything that could break the filter before interpolating the term.
  useEffect(() => {
    const term = query.trim().replace(/[(),*]/g, ' ').trim();
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
      const like = `*${term}*`;
      createClient()
        .from('contacts')
        .select('id, name, phone, roll_number, university_roll_number, university')
        .eq('account_id', accountId)
        .or(
          `name.ilike.${like},phone.ilike.${like},roll_number.ilike.${like},university_roll_number.ilike.${like}`
        )
        .order('created_at', { ascending: false })
        .limit(8)
        .then(({ data }) => {
          setHits((data ?? []) as Hit[]);
          setLoading(false);
        });
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
      go(hits[0].id);
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
        placeholder="Search leads by name, phone, roll…"
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
          {hits.map((h) => (
            <button
              key={h.id}
              type="button"
              onClick={() => go(h.id)}
              className="hover:bg-accent focus:bg-accent flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left outline-none"
            >
              <span className="text-foreground text-sm font-medium">
                {h.name || h.phone || 'Unnamed lead'}
              </span>
              <span className="text-muted-foreground truncate text-xs">
                {[
                  h.phone,
                  h.university_roll_number || h.roll_number,
                  h.university,
                ]
                  .filter(Boolean)
                  .join(' · ') || '—'}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
