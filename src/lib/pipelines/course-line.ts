/**
 * The course line on a pipeline card. In order:
 *   1. the contact's own university (set once the student applies);
 *   2. the newest interest the bot recorded on the contact's conversations
 *      (migrations 038/040), loaded with the board's deals, so Enrolled and
 *      Lost deals are covered too;
 *   3. the queue insight (lead_queue), which only covers workable stages;
 *   4. a plain "not chosen yet" when none of these knows anything.
 */

/** Interest columns mirrored onto a conversation (migrations 038/040). */
export interface ConversationInterest {
  interest_university?: string | null;
  interest_course?: string | null;
  interest_specialization?: string | null;
  interest_updated_at?: string | null;
}

interface ContactCourse {
  university?: string | null;
  intake_year?: string | null;
  intake_session?: string | null;
  conversations?: ConversationInterest[] | null;
}

interface InterestCourse {
  university: string | null;
  course: string | null;
  specialization: string | null;
}

function interestParts(i: InterestCourse | null | undefined): string[] {
  return [i?.university, i?.course, i?.specialization].filter(
    (p): p is string => Boolean(p)
  );
}

/** The most recently updated conversation interest that says anything. */
function newestInterest(
  conversations: ConversationInterest[] | null | undefined
): InterestCourse | null {
  const known = (conversations ?? [])
    .map((c) => ({
      at: c.interest_updated_at ?? '',
      university: c.interest_university ?? null,
      course: c.interest_course ?? null,
      specialization: c.interest_specialization ?? null,
    }))
    .filter((c) => interestParts(c).length > 0)
    .sort((a, b) => b.at.localeCompare(a.at));
  return known[0] ?? null;
}

export function courseLine(
  contact: ContactCourse | null | undefined,
  insight?: InterestCourse | null
): string {
  if (contact?.university) {
    const intake = contact.intake_year
      ? ` • 20${contact.intake_year}${contact.intake_session ?? ''}`
      : '';
    return `${contact.university}${intake}`;
  }
  for (const source of [newestInterest(contact?.conversations), insight]) {
    const parts = interestParts(source);
    if (parts.length > 0) return parts.join(' · ');
  }
  return 'University not chosen yet';
}
