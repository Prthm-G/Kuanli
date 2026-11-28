'use client';

import { useState } from 'react';
import { Check, Copy, MessageCircle } from 'lucide-react';
import { toast } from 'sonner';

import { JOURNEY_STEPS, journeyPosition } from '@/lib/students/journey';
import { whatsappChatUrl } from '@/lib/inbox/wa-link';
import { cn } from '@/lib/utils';

const STEP_CLASS = {
  done: 'bg-primary/15 text-primary',
  current: 'bg-primary text-primary-foreground font-semibold',
  todo: 'bg-muted text-muted-foreground',
} as const;

export function JourneyBar({ stageName }: { stageName: string | null }) {
  const pos = journeyPosition(stageName);
  return (
    <ol
      aria-label="Student journey"
      className="flex flex-wrap items-center gap-1 text-[10px]"
    >
      {JOURNEY_STEPS.map((label, i) => {
        const state =
          pos.step === null || i > pos.step
            ? 'todo'
            : i < pos.step
              ? 'done'
              : 'current';
        return (
          <li
            key={label}
            aria-current={state === 'current' ? 'step' : undefined}
            className={cn('rounded-full px-1.5 py-0.5', STEP_CLASS[state])}
          >
            {label}
          </li>
        );
      })}
      {pos.closed && (
        <li className="rounded-full bg-red-500/15 px-1.5 py-0.5 font-semibold text-red-400">
          {pos.closed}
        </li>
      )}
    </ol>
  );
}

function CopyValue({ label, value }: { label: string; value: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!value) {
    return (
      <div className="flex justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-muted-foreground">Not set</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          toast.error('Could not copy');
        }
      }}
      className="hover:bg-muted flex w-full items-center justify-between gap-2 rounded px-1 text-left text-xs"
      aria-label={`Copy ${label}`}
    >
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground flex min-w-0 items-center gap-1 font-mono">
        <span className="truncate">{value}</span>
        {copied ? (
          <Check className="text-primary h-3 w-3 shrink-0" />
        ) : (
          <Copy className="text-muted-foreground h-3 w-3 shrink-0" />
        )}
      </span>
    </button>
  );
}

export interface StudentHeaderProps {
  name: string;
  phones: string[];
  branchName: string | null;
  ownerName: string | null;
  stageName: string | null;
  provisionalAppId: string | null;
  universityAppNumber: string | null;
  registrationNumber: string | null;
  error: boolean;
}

/** Always-visible strip: who the student is and where they are, every value copyable. */
export function StudentHeader(p: StudentHeaderProps) {
  const waUrl = p.phones[0] ? whatsappChatUrl(p.phones[0]) : null;
  return (
    <div className="border-border space-y-2 border-b p-3">
      <h3 className="text-foreground truncate text-sm font-semibold">
        {p.name}
      </h3>
      <div className="space-y-0.5">
        {p.phones.map((ph, i) => (
          <CopyValue key={ph} label={i === 0 ? 'Phone' : 'Also'} value={ph} />
        ))}
        <CopyValue label="Branch" value={p.branchName} />
        <CopyValue label="Owner" value={p.ownerName} />
        <CopyValue label="Stage" value={p.stageName} />
        <CopyValue label="Provisional ID" value={p.provisionalAppId} />
        <CopyValue label="Univ. app no." value={p.universityAppNumber} />
        <CopyValue label="Reg. no." value={p.registrationNumber} />
      </div>
      {p.error && (
        <p className="text-xs text-amber-500">
          Some details did not load. Reopen to retry.
        </p>
      )}
      <JourneyBar stageName={p.stageName} />
      {waUrl && (
        <a
          href={waUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground hover:bg-muted inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs"
        >
          <MessageCircle className="h-3 w-3" aria-hidden="true" /> Open in
          WhatsApp
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      )}
    </div>
  );
}
