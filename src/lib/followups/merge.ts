/**
 * Merge-field rendering for free-form follow-up bodies (migration 044).
 *
 * Two fields, both with fallbacks so a missing value never leaves a hole or
 * a template artifact in an outbound WhatsApp message:
 *   {{name}}       -> the contact's first name, else "there"
 *   {{university}} -> the bot-resolved interest university, else
 *                     "your course options"
 *
 * WhatsApp profile names are usually full names; greeting with just the
 * first word reads naturally ("Hi Pratham," not "Hi Pratham Goel,").
 */

export interface MergeFields {
  name?: string | null;
  university?: string | null;
}

export function renderFollowUpBody(body: string, fields: MergeFields): string {
  const firstName = (fields.name ?? '').trim().split(/\s+/)[0] || 'there';
  const university = (fields.university ?? '').trim() || 'your course options';
  return body
    .replaceAll('{{name}}', firstName)
    .replaceAll('{{university}}', university);
}
