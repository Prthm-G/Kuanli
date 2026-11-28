'use client';

import type { Contact, Conversation } from '@/types';
import { StudentPanel } from '@/components/students/student-panel';
import { cn } from '@/lib/utils';

interface ContactSidebarProps {
  contact: Contact | null;
  /** The open thread. Supplies the bot-inferred university that pre-fills
   *  enrollment; optional so the sidebar still renders without one. */
  conversation?: Conversation | null;
  /** Called after enrollment succeeds so the parent can refetch instead of
   *  the component reloading the whole page. */
  onContactUpdated?: () => void;
  /** Overrides the desktop width, for the phone sheet. */
  className?: string;
}

/** The inbox's right panel: the shared StudentPanel inline (R1b). Same props as before, so the inbox is unchanged. */
export function ContactSidebar({
  contact,
  conversation,
  onContactUpdated,
  className,
}: ContactSidebarProps) {
  if (!contact) {
    return (
      <div className="border-border bg-card flex h-full w-70 items-center justify-center border-l">
        <p className="text-muted-foreground text-sm">Select a conversation</p>
      </div>
    );
  }
  return (
    <StudentPanel
      contact={contact}
      conversation={conversation}
      onContactUpdated={onContactUpdated}
      className={cn('border-border bg-card w-70 border-l', className)}
    />
  );
}
