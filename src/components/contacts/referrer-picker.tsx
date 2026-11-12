'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, X } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import {
  createReferrer,
  searchReferrers,
  type ReferrerOption,
} from '@/lib/contacts/referrer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * "Referred by" for a contact whose source is Reference. Searches the
 * caller's own account through the browser (RLS) client, or adds a new
 * person (name + phone) on the spot. `legacyName` is the old free-text
 * `source_detail`, shown when no contact is linked yet.
 */

export interface ReferrerValue {
  id: string | null;
  name: string;
}

interface ReferrerPickerProps {
  value: ReferrerValue;
  onChange: (value: ReferrerValue) => void;
  /** The contact being edited, so nobody is offered as their own referrer. */
  excludeContactId?: string;
  compact?: boolean;
}

export function ReferrerPicker({
  value,
  onChange,
  excludeContactId,
  compact,
}: ReferrerPickerProps) {
  const supabase = useMemo(() => createClient(), []);
  const { accountId, user } = useAuth();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ReferrerOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [saving, setSaving] = useState(false);
  const [found, setFound] = useState<ReferrerOption | null>(null);

  useEffect(() => {
    if (!accountId || value.id) return;
    const q = query.trim();
    if (q.length < 2) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setSearching(true);
      const found = await searchReferrers(supabase, accountId, q, excludeContactId);
      if (!cancelled) {
        setResults(found);
        setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, accountId, supabase, excludeContactId, value.id]);

  function pick(r: ReferrerOption) {
    onChange({ id: r.id, name: r.name || r.phone });
    setQuery('');
    setResults([]);
    setSearching(false);
  }

  async function addPerson() {
    if (!accountId || !user) return;
    setSaving(true);
    const out = await createReferrer(supabase, {
      accountId,
      userId: user.id,
      name: newName,
      phone: newPhone,
    });
    setSaving(false);
    if (!out.ok) {
      setFound(out.existing ?? null);
      toast.error(out.error);
      return;
    }
    setFound(null);
    pick(out.referrer);
    setAdding(false);
    setNewName('');
    setNewPhone('');
  }

  // Stale results from a longer query never show once it is cleared.
  const shown = query.trim().length >= 2 ? results : [];
  const showSearching = searching && shown.length === 0 && query.trim().length >= 2;

  const inputCls = compact
    ? 'bg-muted border-border text-foreground h-8 text-sm'
    : 'bg-muted border-border text-foreground placeholder:text-muted-foreground';

  return (
    <div className="space-y-2">
      <Label className="text-muted-foreground text-xs">Referred by</Label>

      {value.id ? (
        <div className="bg-muted border-border flex items-center justify-between rounded-md border px-3 py-1.5 text-sm">
          <span>{value.name}</span>
          <button
            type="button"
            aria-label="Remove referrer"
            onClick={() => onChange({ id: null, name: '' })}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : (
        <>
          {value.name && (
            <p className="text-muted-foreground text-xs">
              Noted earlier: {value.name}. Pick the contact to link it.
            </p>
          )}
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or phone"
            aria-label="Search referrer by name or phone"
            className={inputCls}
          />
          {showSearching && (
            <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Loader2 className="size-3 animate-spin" />
              Searching
            </p>
          )}
          {shown.length > 0 && (
            <ul className="border-border max-h-40 overflow-auto rounded-md border">
              {shown.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => pick(r)}
                    className="hover:bg-muted flex w-full justify-between px-3 py-1.5 text-left text-sm"
                  >
                    <span>{r.name || 'No name'}</span>
                    <span className="text-muted-foreground text-xs">{r.phone}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!adding ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setAdding(true)}
              className="border-border text-muted-foreground hover:bg-muted h-7 text-xs"
            >
              <Plus className="size-3" />
              New person
            </Button>
          ) : (
            <div className="border-border space-y-2 rounded-md border p-2">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Name"
                aria-label="New referrer name"
                className={inputCls}
              />
              <Input
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                placeholder="Phone, with country code"
                aria-label="New referrer phone"
                className={inputCls}
              />
              {found && (
                <button
                  type="button"
                  onClick={() => {
                    pick(found);
                    setFound(null);
                    setAdding(false);
                  }}
                  className="text-primary text-xs underline underline-offset-2"
                >
                  Link {found.name || found.phone} instead
                </button>
              )}
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={saving || !newName.trim() || !newPhone.trim()}
                  onClick={addPerson}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground h-7 text-xs"
                >
                  {saving && <Loader2 className="size-3 animate-spin" />}
                  Add and link
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setAdding(false)}
                  className="border-border text-muted-foreground h-7 text-xs"
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
