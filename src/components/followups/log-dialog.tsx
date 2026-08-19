'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { logFollowUp } from '@/lib/followups/queries';
import {
  FOLLOWUP_METHODS,
  FOLLOWUP_OUTCOMES,
  METHOD_LABEL,
  OUTCOME_LABEL,
  type FollowUpMethod,
  type FollowUpOutcome,
} from '@/lib/followups/types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * `<input type="datetime-local">` and `type="date"` want local wall-clock
 * strings, not ISO instants. These two helpers are the only place that
 * conversion happens, so a timezone bug has one home.
 */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function toLocalDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

interface LogDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string;
  contactName?: string | null;
  conversationId?: string | null;
  /** Called after a successful insert so the caller can refetch. */
  onLogged: () => void;
}

/**
 * Record one human follow-up. The next-step half is optional but load-bearing:
 * it is the only thing that puts a contact on the worklist, and filing a new
 * entry closes whatever the previous one promised (migration 054).
 */
export function LogDialog({
  open,
  onOpenChange,
  contactId,
  contactName,
  conversationId,
  onLogged,
}: LogDialogProps) {
  const { accountId, user } = useAuth();

  const [occurredAt, setOccurredAt] = useState('');
  const [method, setMethod] = useState<FollowUpMethod>('call');
  const [outcome, setOutcome] = useState<FollowUpOutcome | ''>('');
  const [summary, setSummary] = useState('');
  const [nextDue, setNextDue] = useState('');
  const [nextMethod, setNextMethod] = useState<FollowUpMethod>('call');
  const [saving, setSaving] = useState(false);

  // Reset on every open rather than on close: a dialog that reopens holding
  // the last student's notes is how the wrong summary gets filed.
  useEffect(() => {
    if (!open) return;
    setOccurredAt(toLocalInput(new Date()));
    setMethod('call');
    setOutcome('');
    setSummary('');
    setNextDue('');
    setNextMethod('call');
  }, [open]);

  async function save() {
    if (!accountId || !user?.id) return;
    if (!summary.trim()) {
      toast.error('Add a short summary of the conversation');
      return;
    }
    setSaving(true);
    try {
      await logFollowUp(createClient(), accountId, user.id, {
        contactId,
        conversationId: conversationId ?? null,
        occurredAt: occurredAt
          ? new Date(occurredAt).toISOString()
          : new Date().toISOString(),
        method,
        outcome: outcome || null,
        summary,
        // A bare date means "some time that day"; 9am local is a working-hours
        // default that keeps the entry in the right calendar bucket.
        nextDueAt: nextDue ? new Date(`${nextDue}T09:00`).toISOString() : null,
        nextMethod: nextDue ? nextMethod : null,
      });
      toast.success('Follow-up logged');
      onOpenChange(false);
      onLogged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not log follow-up');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            Log a follow-up
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {contactName
              ? `What happened with ${contactName}, and what is the next step.`
              : 'What happened, and what is the next step.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="fu-when">When</Label>
              <Input
                id="fu-when"
                type="datetime-local"
                value={occurredAt}
                max={toLocalInput(new Date())}
                onChange={(e) => setOccurredAt(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Method</Label>
              <Select
                value={method}
                onValueChange={(v) => setMethod(v as FollowUpMethod)}
              >
                <SelectTrigger className="bg-muted">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FOLLOWUP_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {METHOD_LABEL[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Outcome</Label>
            <Select
              value={outcome || '__none__'}
              onValueChange={(v) =>
                setOutcome(v === '__none__' ? '' : (v as FollowUpOutcome))
              }
            >
              <SelectTrigger className="bg-muted">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— Not recorded —</SelectItem>
                {FOLLOWUP_OUTCOMES.map((o) => (
                  <SelectItem key={o} value={o}>
                    {OUTCOME_LABEL[o]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="fu-summary">Summary</Label>
            <Textarea
              id="fu-summary"
              rows={3}
              value={summary}
              placeholder="What was discussed, what they asked for, what you promised."
              onChange={(e) => setSummary(e.target.value)}
            />
          </div>

          <div className="border-border space-y-3 rounded-lg border p-3">
            <div className="space-y-1.5">
              <Label htmlFor="fu-next">Next follow-up</Label>
              <p className="text-muted-foreground text-xs">
                Leave empty if nothing is owed. Setting a date puts this student
                on the worklist and closes any earlier commitment.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Input
                  id="fu-next"
                  type="date"
                  value={nextDue}
                  min={toLocalDate(new Date())}
                  onChange={(e) => setNextDue(e.target.value)}
                />
                <Select
                  value={nextMethod}
                  onValueChange={(v) => setNextMethod(v as FollowUpMethod)}
                  disabled={!nextDue}
                >
                  <SelectTrigger className="bg-muted">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FOLLOWUP_METHODS.map((m) => (
                      <SelectItem key={m} value={m}>
                        {METHOD_LABEL[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Log follow-up'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
