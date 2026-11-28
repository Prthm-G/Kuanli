'use client';

import { useEffect, useState } from 'react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import type { Contact, Conversation } from '@/types';
import { hasMinRole } from '@/lib/auth/roles';
import { showsApplicationPanel } from '@/lib/applications/panel-rules';
import {
  loadApplication,
  type ApplicationRecord,
} from '@/lib/applications/application-queries';
import {
  loadBranchAndOwner,
  loadStudentSet,
  type StudentRecord,
} from '@/lib/students/queries';
import { pickCurrentDeal } from '@/lib/students/journey';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApplicationPanel } from '@/components/applications/application-panel';
import { DocumentsTab } from '@/components/applications/documents-tab';
import { StudentPayments } from '@/components/payments/student-payments';
import { PortalCredentialsTab } from '@/components/contacts/portal-credentials-tab';
import { cn } from '@/lib/utils';
import { useStudentData } from './use-student-data';
import { StudentHeader } from './student-header';
import { ActivityTab } from './activity-tab';
import { DetailsTab } from './details-tab';
import { NotesTab } from './notes-tab';

export interface StudentPanelProps {
  contact: Contact;
  /** The open thread, inline in the inbox only (pre-fills enrollment and the follow-up chat link). */
  conversation?: Conversation | null;
  onContactUpdated?: () => void;
  className?: string;
}

const TAB_LIST =
  'bg-muted/50 border-border mx-3 mt-2 flex w-auto justify-start overflow-x-auto overflow-y-hidden border-b ' +
  '[scrollbar-width:thin] group-data-horizontal/tabs:h-auto [&>[data-slot=tabs-trigger]]:flex-none';

/** One student, everywhere: inline in the inbox and inside the ?student= drawer (spec R1b). */
export function StudentPanel({
  contact,
  conversation,
  onContactUpdated,
  className,
}: StudentPanelProps) {
  const { accountId, accountRole, user } = useAuth();
  const canEdit = accountRole !== null && accountRole !== 'viewer';
  const canKeepFiles = accountRole !== null && hasMinRole(accountRole, 'admin');
  const data = useStudentData(contact);
  const [records, setRecords] = useState<StudentRecord[]>([]);
  const [app, setApp] = useState<ApplicationRecord | null>(null);
  const [extras, setExtras] = useState<{
    branchName: string | null;
    ownerName: string | null;
  }>({ branchName: null, ownerName: null });
  const [headerError, setHeaderError] = useState(false);
  const [headerKey, setHeaderKey] = useState(0);
  const [tab, setTab] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    void (async () => {
      const db = createClient();
      const [set, application, bo] = await Promise.allSettled([
        loadStudentSet(db, accountId, contact.id),
        loadApplication(db, contact.id),
        loadBranchAndOwner(
          db,
          contact.branch_id ?? null,
          contact.owner_profile_id ?? null
        ),
      ]);
      if (cancelled) return;
      if (set.status === 'fulfilled') setRecords(set.value);
      if (application.status === 'fulfilled') setApp(application.value);
      if (bo.status === 'fulfilled') setExtras(bo.value);
      setHeaderError(
        [set, application, bo].some((r) => r.status === 'rejected')
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [
    accountId,
    contact.id,
    contact.branch_id,
    contact.owner_profile_id,
    headerKey,
  ]);

  const current = pickCurrentDeal(data.deals);
  const showsApp = showsApplicationPanel(data.deals, data.stages);
  // A picked Application tab falls back to Activity once the deal leaves the panel's stages (e.g. moved to Lost).
  const picked = tab === 'application' && !showsApp ? null : tab;
  const active = picked ?? (showsApp ? 'application' : 'activity');
  const phones =
    records.length > 0
      ? [
          ...new Set(
            records.map((r) => r.phone).filter((p): p is string => !!p)
          ),
        ]
      : [contact.phone];
  const refreshAll = () => {
    void data.reload();
    setHeaderKey((k) => k + 1);
  };

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <StudentHeader
        name={contact.name || contact.phone}
        phones={phones}
        branchName={extras.branchName}
        ownerName={extras.ownerName}
        stageName={current?.stage?.name ?? null}
        provisionalAppId={app?.provisionalAppId ?? null}
        universityAppNumber={app?.universityAppNumber ?? null}
        registrationNumber={app?.registrationNumber ?? null}
        error={headerError}
      />
      {/* min-h-0 is load-bearing (issue #229): without it the tabs grow instead of scrolling. */}
      <Tabs
        value={active}
        onValueChange={(v) => setTab(String(v))}
        className="min-h-0 flex-1 gap-0"
      >
        <TabsList className={TAB_LIST}>
          {showsApp && (
            <TabsTrigger value="application">Application</TabsTrigger>
          )}
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="payments">Payments</TabsTrigger>
          <TabsTrigger value="credentials">Credentials</TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
        </TabsList>
        {showsApp && accountId && user && (
          <TabsContent
            value="application"
            className="flex min-h-0 flex-1 flex-col"
          >
            <ScrollArea className="min-h-0 flex-1">
              <div className="p-3">
                <ApplicationPanel
                  key={contact.id}
                  contactId={contact.id}
                  accountId={accountId}
                  userId={user.id}
                  canEdit={canEdit}
                  contactEmail={contact.email ?? null}
                  contactUniversity={contact.university ?? null}
                  onSaved={refreshAll}
                />
              </div>
            </ScrollArea>
          </TabsContent>
        )}
        <TabsContent value="activity" className="flex min-h-0 flex-1 flex-col">
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-3">
              <ActivityTab
                contactId={contact.id}
                contactName={contact.name}
                conversationId={conversation?.id ?? null}
                refreshKey={headerKey}
              />
            </div>
          </ScrollArea>
        </TabsContent>
        <TabsContent value="payments" className="flex min-h-0 flex-1 flex-col">
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-3">
              <StudentPayments
                contactId={contact.id}
                contactName={contact.name}
                onChanged={onContactUpdated}
              />
            </div>
          </ScrollArea>
        </TabsContent>
        <TabsContent
          value="credentials"
          className="flex min-h-0 flex-1 flex-col"
        >
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-3">
              <PortalCredentialsTab contactId={contact.id} />
            </div>
          </ScrollArea>
        </TabsContent>
        <TabsContent value="documents" className="flex min-h-0 flex-1 flex-col">
          <ScrollArea className="min-h-0 flex-1">
            {accountId && user ? (
              <DocumentsTab
                key={contact.id}
                contactId={contact.id}
                accountId={accountId}
                userId={user.id}
                contactUniversity={contact.university ?? null}
                canEdit={canEdit}
                canKeepFiles={canKeepFiles}
                onChanged={refreshAll}
              />
            ) : null}
          </ScrollArea>
        </TabsContent>
        <TabsContent value="notes" className="flex min-h-0 flex-1 flex-col">
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-3">
              <NotesTab
                contactId={contact.id}
                notes={data.notes}
                onAdded={(n) => {
                  data.addNote(n);
                  setHeaderKey((k) => k + 1);
                }}
              />
            </div>
          </ScrollArea>
        </TabsContent>
        <TabsContent value="details" className="flex min-h-0 flex-1 flex-col">
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-3">
              <DetailsTab
                contact={contact}
                conversation={conversation}
                deals={data.deals}
                stages={data.stages}
                tags={data.tags}
                canEditStage={canEdit}
                onStageChange={data.changeStage}
                onContactUpdated={onContactUpdated}
              />
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
}
