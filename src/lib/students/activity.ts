import { METHOD_LABEL } from '@/lib/followups/types';
import type { StudentTimelineItem } from './queries';

export function activityTitle(item: StudentTimelineItem): string {
  switch (item.kind) {
    case 'follow_up':
      return item.method ? METHOD_LABEL[item.method] : 'Follow-up';
    case 'bot_follow_up':
      return 'Automated follow-up';
    case 'note':
      return 'Note';
    case 'stage':
      return 'Stage';
  }
}

/** "via …1234" on rows that came from another linked record. */
export function viaLabel(
  item: StudentTimelineItem,
  openedContactId: string
): string | null {
  if (item.contactId === openedContactId) return null;
  return item.phoneLast4 ? `via …${item.phoneLast4}` : 'via another record';
}
