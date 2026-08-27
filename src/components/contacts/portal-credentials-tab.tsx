'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { PortalCredential } from '@/types';
import { useCan } from '@/hooks/use-can';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Copy,
  Check,
  Eye,
  ExternalLink,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react';

/**
 * Saved student portal logins for one contact (migration 072). All data
 * flows through /api/contacts/[contactId]/portal-credentials — the table is
 * unreachable from the browser client by design. Passwords appear only
 * after an explicit reveal (which the server audit-logs) and are cleared
 * from state after 30 seconds.
 */

interface PortalCredentialsTabProps {
  contactId: string;
}

const REVEAL_CLEAR_MS = 30_000;

export function PortalCredentialsTab({ contactId }: PortalCredentialsTabProps) {
  const canManage = useCan('send-messages');

  const [credentials, setCredentials] = useState<PortalCredential[]>([]);
  const [loading, setLoading] = useState(true);

  // Add form
  const [showForm, setShowForm] = useState(false);
  const [label, setLabel] = useState('');
  const [portalUrl, setPortalUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  // Per-credential transient state
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [revealing, setRevealing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const clearTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const base = `/api/contacts/${contactId}/portal-credentials`;

  const fetchCredentials = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(base);
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { credentials: PortalCredential[] };
      setCredentials(data.credentials ?? []);
    } catch {
      toast.error('Failed to load portal credentials');
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    if (canManage) void fetchCredentials();
    const timers = clearTimers.current;
    return () => {
      for (const t of Object.values(timers)) clearTimeout(t);
    };
  }, [canManage, fetchCredentials]);

  async function copyValue(key: string, value: string) {
    await navigator.clipboard.writeText(value);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 2000);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          label,
          portal_url: portalUrl,
          username,
          password,
          notes,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { error?: string }
        | null;
      if (!res.ok) throw new Error(data?.error || 'Failed to save credential');
      toast.success('Credential saved');
      setShowForm(false);
      setLabel('');
      setPortalUrl('');
      setUsername('');
      setPassword('');
      setNotes('');
      void fetchCredentials();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save credential');
    } finally {
      setSaving(false);
    }
  }

  async function handleReveal(id: string) {
    setRevealing(id);
    try {
      const res = await fetch(`${base}/${id}/reveal`, { method: 'POST' });
      const data = (await res.json().catch(() => null)) as
        | { password?: string; error?: string }
        | null;
      if (!res.ok) {
        throw new Error(
          res.status === 429
            ? 'Too many reveals — wait a minute'
            : data?.error || 'Failed to reveal password',
        );
      }
      setRevealed((prev) => ({ ...prev, [id]: data?.password ?? '' }));
      clearTimeout(clearTimers.current[id]);
      clearTimers.current[id] = setTimeout(() => {
        setRevealed((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }, REVEAL_CLEAR_MS);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to reveal password');
    } finally {
      setRevealing(null);
    }
  }

  async function handleDelete(id: string) {
    try {
      const res = await fetch(`${base}/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      toast.success('Credential deleted');
      setConfirmDelete(null);
      void fetchCredentials();
    } catch {
      toast.error('Failed to delete credential');
    }
  }

  if (!canManage) {
    return (
      <p className="text-sm text-muted-foreground">
        Saved portal logins require the Counsellor role.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          University portal logins for this student. Reveals are logged.
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowForm((v) => !v)}
          className="border-border text-muted-foreground hover:bg-muted"
        >
          <Plus className="size-3.5" />
          Add
        </Button>
      </div>

      {showForm && (
        <form
          onSubmit={handleAdd}
          className="space-y-2 rounded-md border border-border bg-muted/30 p-3"
        >
          <div className="space-y-1.5">
            <Label className="text-muted-foreground text-xs">
              Label <span className="text-red-400">*</span>
            </Label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="LPU UMS"
              className="bg-muted border-border text-foreground h-8 text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-muted-foreground text-xs">Portal URL</Label>
            <Input
              value={portalUrl}
              onChange={(e) => setPortalUrl(e.target.value)}
              placeholder="https://ums.lpu.in"
              className="bg-muted border-border text-foreground h-8 text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-muted-foreground text-xs">Username</Label>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="bg-muted border-border text-foreground h-8 text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-muted-foreground text-xs">
              Password <span className="text-red-400">*</span>
            </Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="bg-muted border-border text-foreground h-8 text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-muted-foreground text-xs">Notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="bg-muted border-border text-foreground text-sm"
            />
          </div>
          <Button
            type="submit"
            size="sm"
            disabled={saving || !label.trim() || !password}
            className="bg-primary hover:bg-primary/90 text-primary-foreground w-full"
          >
            {saving && <Loader2 className="size-3.5 animate-spin" />}
            Save Credential
          </Button>
        </form>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="size-3 animate-spin" />
          Loading…
        </div>
      ) : credentials.length === 0 ? (
        !showForm && (
          <p className="text-sm text-muted-foreground">
            No portal logins saved for this student yet.
          </p>
        )
      ) : (
        <div className="space-y-2">
          {credentials.map((cred) => (
            <div
              key={cred.id}
              className="rounded-md border border-border bg-muted/30 p-3 space-y-1.5"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-foreground">
                  {cred.label}
                </p>
                <div className="flex items-center gap-1">
                  {cred.portal_url && (
                    <a
                      href={cred.portal_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-foreground p-1"
                      title="Open portal"
                    >
                      <ExternalLink className="size-3.5" />
                    </a>
                  )}
                  {confirmDelete === cred.id ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleDelete(cred.id)}
                      className="h-6 border-red-500/40 text-red-400 hover:bg-red-500/10 text-xs"
                    >
                      Confirm
                    </Button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(cred.id)}
                      className="text-muted-foreground hover:text-red-400 p-1"
                      title="Delete"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {cred.username && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span>User: {cred.username}</span>
                  <button
                    type="button"
                    onClick={() => copyValue(`u-${cred.id}`, cred.username!)}
                    className="hover:text-foreground"
                    title="Copy username"
                  >
                    {copiedKey === `u-${cred.id}` ? (
                      <Check className="size-3" />
                    ) : (
                      <Copy className="size-3" />
                    )}
                  </button>
                </div>
              )}

              {revealed[cred.id] !== undefined ? (
                <div className="flex items-center gap-1.5 text-xs">
                  <code className="bg-muted rounded px-1.5 py-0.5 text-foreground">
                    {revealed[cred.id]}
                  </code>
                  <button
                    type="button"
                    onClick={() => copyValue(`p-${cred.id}`, revealed[cred.id])}
                    className="text-muted-foreground hover:text-foreground"
                    title="Copy password"
                  >
                    {copiedKey === `p-${cred.id}` ? (
                      <Check className="size-3" />
                    ) : (
                      <Copy className="size-3" />
                    )}
                  </button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleReveal(cred.id)}
                  disabled={revealing === cred.id}
                  className="h-6 border-border text-muted-foreground hover:bg-muted text-xs"
                >
                  {revealing === cred.id ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Eye className="size-3" />
                  )}
                  Reveal password
                </Button>
              )}

              {cred.notes && (
                <p className="text-xs text-muted-foreground">{cred.notes}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
