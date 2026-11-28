'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import type { Contact } from '@/types';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { readStudentParam, studentHref } from '@/lib/students/drawer-url';
import { StudentPanel } from './student-panel';

/** Open the student drawer on the current page. Reads the URL at click time, so callers need no useSearchParams. */
export function useOpenStudent(): (contactId: string) => void {
  const router = useRouter();
  return useCallback(
    (contactId: string) => router.push(studentHref(window.location.pathname, window.location.search, contactId), { scroll: false }),
    [router],
  );
}

/**
 * The one student drawer (spec R1b), mounted once in the dashboard shell. ?student=<contactId> opens it on any page;
 * closing removes the param. A contact the viewer cannot see and one that does not exist read the same.
 */
export function StudentDrawerHost() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { accountId } = useAuth();
  const contactId = readStudentParam(searchParams.get('student'));
  const [loaded, setLoaded] = useState<{ id: string; contact: Contact | null; failed: boolean } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!contactId || !accountId) return;
    let cancelled = false;
    void (async () => {
      const { data, error } = await createClient().from('contacts').select('*').eq('id', contactId).eq('account_id', accountId).maybeSingle();
      if (cancelled) return;
      if (error) console.error('Student load failed:', error.message);
      setLoaded({ id: contactId, contact: (data as Contact | null) ?? null, failed: !!error });
    })();
    return () => { cancelled = true; };
  }, [contactId, accountId, reloadKey]);

  const close = () => router.replace(studentHref(pathname, searchParams.toString(), null), { scroll: false });
  const current = loaded && loaded.id === contactId ? loaded : null;

  return (
    <Sheet open={!!contactId} onOpenChange={(open) => { if (!open) close(); }}>
      <SheetContent side="right" className="bg-card w-full gap-0 p-0 sm:max-w-xl">
        <SheetTitle className="sr-only">Student</SheetTitle>
        {!current ? (
          <div className="flex h-full items-center justify-center"><Loader2 className="text-primary size-6 animate-spin" /></div>
        ) : current.contact ? (
          <StudentPanel key={current.contact.id} contact={current.contact} onContactUpdated={() => setReloadKey((k) => k + 1)} className="h-full w-full" />
        ) : (
          <p className="text-muted-foreground p-6 text-sm">
            {current.failed ? 'Could not load this student. Try again.' : 'This student is not available.'}
          </p>
        )}
      </SheetContent>
    </Sheet>
  );
}
