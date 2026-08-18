/**
 * Translate the bot's university name into the enrollment code that goes into
 * a roll number.
 *
 * These two vocabularies are not the same and never were. `Auretris - Main`
 * classifies leads as `LPU`, `Amity` or `DBU`; the enrollment control writes
 * `LPU`, `AMI` or `DBU`, and `generate_roll_number()` splices that value
 * straight into the id — `'D' || university || intake_year || ...`, so
 * `DLPU26J0001`. Passing the bot's "Amity" through unmapped would mint
 * `DAmity26J0001` and there is no constraint to catch it.
 *
 * Anything not mapped returns null on purpose. The dialog then leaves the
 * university unselected and makes the agent choose, which is the right failure
 * mode for a value that becomes a permanent identifier.
 *
 * Operator decisions, 2026-08-18: DBU leads are enrolled, so DBU joined the
 * list; CU is no longer a live partner and was dropped (no CU enrollment was
 * ever minted, verified against the live DB before removal).
 */

/** Enrollment codes offered by the roll-number generator. */
export const ENROLLMENT_UNIVERSITIES = [
  { code: 'LPU', label: 'Lovely Professional University (LPU)' },
  { code: 'AMI', label: 'Amity University (AMI)' },
  { code: 'DBU', label: 'Desh Bhagat University (DBU)' },
] as const;

const BOT_TO_ENROLLMENT: Record<string, string> = {
  lpu: 'LPU',
  amity: 'AMI',
  ami: 'AMI',
  dbu: 'DBU',
};

export function toEnrollmentCode(
  botUniversity: string | null | undefined
): string | null {
  if (!botUniversity) return null;
  return BOT_TO_ENROLLMENT[botUniversity.trim().toLowerCase()] ?? null;
}

/**
 * Default intake session from a date. July and August are the two intakes the
 * enrollment control offers; anything earlier in the year is heading for July,
 * anything from September on has missed both and is treated as next July, which
 * the agent can override in the dialog.
 */
export function defaultIntake(now: Date = new Date()): {
  year: string;
  session: string;
} {
  const yy = (y: number) => String(y % 100).padStart(2, '0');
  const month = now.getMonth(); // 0-indexed
  if (month <= 6) return { year: yy(now.getFullYear()), session: 'J' };
  if (month === 7) return { year: yy(now.getFullYear()), session: 'A' };
  return { year: yy(now.getFullYear() + 1), session: 'J' };
}
