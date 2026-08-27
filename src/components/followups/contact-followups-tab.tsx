'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { FollowUpTimeline } from './timeline';
import { LogDialog } from './log-dialog';

interface ContactFollowupsTabProps {
  contactId: string;
  contactName?: string | null;
}

/**
 * Per-student follow-up history plus the log button, packaged so the contact
 * sheet and the inbox sidebar can both mount it without either growing a copy
 * of the state. Viewers see the history but cannot log — the RLS INSERT policy
 * requires agent, so hiding the button matches what the database would do.
 */
export function ContactFollowupsTab({
  contactId,
  contactName,
}: ContactFollowupsTabProps) {
  const { accountRole } = useAuth();
  const [open, setOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const canLog = accountRole !== null && accountRole !== 'viewer';

  return (
    <div className="space-y-3">
      {canLog && (
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Log follow-up
        </Button>
      )}

      <FollowUpTimeline contactId={contactId} refreshKey={refreshKey} />

      <LogDialog
        open={open}
        onOpenChange={setOpen}
        contactId={contactId}
        contactName={contactName}
        onLogged={() => setRefreshKey((k) => k + 1)}
      />
    </div>
  );
}
