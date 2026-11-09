import { describe, expect, it } from 'vitest';

import { courseLine } from './course-line';

const noInterest = { university: null, course: null, specialization: null };

describe('courseLine', () => {
  it('shows the enrolled university and intake when the contact has one', () => {
    expect(
      courseLine(
        { university: 'LPU', intake_year: '26', intake_session: 'J' },
        { university: 'Amity', course: 'MBA', specialization: null }
      )
    ).toBe('LPU • 2026J');
  });

  it('leaves out the intake when it is not set', () => {
    expect(
      courseLine({ university: 'LPU', intake_year: null, intake_session: null })
    ).toBe('LPU');
  });

  it('falls back to what the lead asked about when no university is set', () => {
    expect(
      courseLine(
        { university: null, intake_year: null, intake_session: null },
        { university: 'LPU', course: 'MBA', specialization: 'Marketing' }
      )
    ).toBe('LPU · MBA · Marketing');
  });

  it('shows a course even when the university is unknown', () => {
    expect(
      courseLine(null, { university: null, course: 'BCA', specialization: null })
    ).toBe('BCA');
  });

  it("uses the contact's own conversations first, so Enrolled and Lost deals (outside the queue) still show the interest", () => {
    const contact = {
      university: null,
      conversations: [
        {
          interest_university: 'Amity',
          interest_course: 'BBA',
          interest_specialization: null,
          interest_updated_at: '2026-10-01T10:00:00Z',
        },
        {
          // newest wins
          interest_university: 'LPU',
          interest_course: 'MBA',
          interest_specialization: 'Finance',
          interest_updated_at: '2026-11-01T10:00:00Z',
        },
        {
          // nothing picked on this chat yet: ignored
          interest_university: null,
          interest_course: null,
          interest_specialization: null,
          interest_updated_at: null,
        },
      ],
    };
    // No queue insight at all (lead_queue leaves out Enrolled and Lost).
    expect(courseLine(contact, undefined)).toBe('LPU · MBA · Finance');
    // And it beats a queue insight when both are there.
    expect(
      courseLine(contact, { university: 'X', course: 'Y', specialization: null })
    ).toBe('LPU · MBA · Finance');
  });

  it('falls back to the queue insight when the conversations say nothing', () => {
    expect(
      courseLine(
        { university: null, conversations: [] },
        { university: null, course: 'BCA', specialization: null }
      )
    ).toBe('BCA');
  });

  it('prefers the university over any interest', () => {
    expect(
      courseLine({
        university: 'LPU',
        intake_year: '26',
        intake_session: 'J',
        conversations: [
          {
            interest_university: 'Amity',
            interest_course: 'MBA',
            interest_specialization: null,
            interest_updated_at: '2026-11-01T10:00:00Z',
          },
        ],
      })
    ).toBe('LPU • 2026J');
  });

  it('says plainly that nothing is known yet', () => {
    expect(courseLine(null, noInterest)).toBe('University not chosen yet');
    expect(courseLine(undefined, undefined)).toBe('University not chosen yet');
  });
});
