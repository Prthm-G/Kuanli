'use client';

import { Mail, Tag as TagIcon, GitBranch } from 'lucide-react';

import type { Contact, Conversation, Deal, PipelineStage } from '@/types';
import { EnrollmentPanel } from '@/components/inbox/enrollment-panel';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAuth } from '@/hooks/use-auth';
import type { StudentRecord } from '@/lib/students/queries';
import type { ContactTag } from './use-student-data';
import { LinkedRecords } from './linked-records';

interface DetailsTabProps {
  contact: Contact;
  conversation?: Conversation | null;
  deals: Deal[];
  stages: PipelineStage[];
  tags: ContactTag[];
  canEditStage: boolean;
  onStageChange: (dealId: string, stageId: string) => Promise<void>;
  onContactUpdated?: () => void;
  records: StudentRecord[];
  onLinksChanged: () => void;
}

/** Contact lines, stage picker, tags and enrollment (moved from the inbox contact sidebar unchanged). */
export function DetailsTab({
  contact,
  conversation,
  deals,
  stages,
  tags,
  canEditStage,
  onStageChange,
  onContactUpdated,
  records,
  onLinksChanged,
}: DetailsTabProps) {
  const { accountId, user } = useAuth();
  return (
    <div>
      {accountId && user && (
        <>
          <LinkedRecords
            accountId={accountId}
            userId={user.id}
            contactId={contact.id}
            records={records}
            canEdit={canEditStage}
            onChanged={onLinksChanged}
          />
          <div className="border-border my-4 border-t" />
        </>
      )}
      {(contact.email || contact.company) && (
        <>
          <div className="space-y-2">
            {contact.company && (
              <p className="text-muted-foreground px-3 text-xs">
                {contact.company}
              </p>
            )}
            {contact.email && (
              <div className="text-muted-foreground flex items-center gap-2 rounded-lg px-3 py-2 text-sm">
                <Mail className="text-muted-foreground h-4 w-4" />
                <span className="truncate">{contact.email}</span>
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="border-border my-4 border-t" />
        </>
      )}

      {/* Stage: the first thing a counsellor needs after the contact. */}
      <div>
        <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs font-medium tracking-wider uppercase">
          <GitBranch className="h-3 w-3" />
          Stage
        </div>
        <div className="mt-2 space-y-2">
          {deals.length === 0 ? (
            <p className="text-muted-foreground px-1 text-xs">No deals</p>
          ) : (
            deals.map((deal) => {
              const options = stages.filter(
                (s) => s.pipeline_id === deal.pipeline_id
              );
              return (
                <div key={deal.id} className="bg-muted rounded-lg px-3 py-2">
                  <p className="text-foreground truncate text-sm font-medium">
                    {deal.title}
                  </p>
                  {canEditStage && options.length > 0 ? (
                    <Select
                      value={deal.stage_id}
                      onValueChange={(value) => {
                        const next = String(value);
                        if (next && next !== deal.stage_id) {
                          void onStageChange(deal.id, next);
                        }
                      }}
                    >
                      <SelectTrigger
                        size="sm"
                        className="bg-background/60 mt-2 w-full"
                        aria-label="Change stage"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {options.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    deal.stage && (
                      <span
                        className="mt-1 inline-block rounded-full px-1.5 py-0.5 text-[10px]"
                        style={{
                          backgroundColor: `${deal.stage.color}20`,
                          color: deal.stage.color,
                        }}
                      >
                        {deal.stage.name}
                      </span>
                    )
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Divider */}
      <div className="border-border my-4 border-t" />

      {/* Tags */}
      <div>
        <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs font-medium tracking-wider uppercase">
          <TagIcon className="h-3 w-3" />
          Tags
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {tags.length === 0 ? (
            <p className="text-muted-foreground px-1 text-xs">No tags</p>
          ) : (
            tags.map((tag) => (
              <span
                key={tag.contact_tag_id}
                className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{
                  backgroundColor: `${tag.color}20`,
                  color: tag.color,
                }}
              >
                {tag.name}
              </span>
            ))
          )}
        </div>
      </div>

      {/* Divider */}
      <div className="border-border my-4 border-t" />

      {/* Enrollment Setup */}
      <div>
        <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs font-medium tracking-wider uppercase">
          University Enrollment
        </div>
        {!contact.university ? (
          /* Keyed on the thread so switching conversations re-seeds the
             suggested university, without resetting the notes / deals /
             tags state the panel also holds. */
          <EnrollmentPanel
            key={conversation?.id ?? 'none'}
            contact={contact}
            interestUniversity={conversation?.interest_university}
            onDone={onContactUpdated}
          />
        ) : (
          <div className="bg-primary/10 border-primary/20 mt-2 rounded-lg border p-3 text-sm">
            <p className="text-primary text-lg font-bold tracking-wide">
              {contact.roll_number}
            </p>
            <p className="text-muted-foreground mt-1 text-xs">
              {contact.university} • 20{contact.intake_year} • Intake{' '}
              {contact.intake_session}
            </p>
            {contact.university_roll_number && (
              <p className="text-muted-foreground mt-1 text-xs">
                Univ. Roll: {contact.university_roll_number}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
