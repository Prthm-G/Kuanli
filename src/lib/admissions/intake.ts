import type { ReconcileResult } from './reconcile';

/**
 * An admission intake as the register stores it: tab "2026-1" is year '26'
 * (or '2026'), session '1'. intake_year is TEXT, so both widths are read as
 * the same year. Two sessions a year, as the office's tabs run.
 */
export type Intake = { year: string; session: string };

const SESSIONS_PER_YEAR = 2;

function fullYear(year: string): number | null {
  const y = year.trim();
  if (/^\d{2}$/.test(y)) return 2000 + Number(y);
  if (/^\d{4}$/.test(y)) return Number(y);
  return null;
}

export function formatIntake(i: Intake): string {
  return `${fullYear(i.year) ?? i.year}-${i.session}`;
}

/**
 * Why a sheet's intake must not be imported, or null when it is plausible:
 * it cannot be read, or it is after next calendar year (IST). A typo tab such
 * as "2062-1" would otherwise write year 62 onto every contact it touches.
 */
export function implausibleIntake(
  sheet: Intake,
  now: Date = new Date()
): string | null {
  const label = formatIntake(sheet);
  const year = fullYear(sheet.year);
  const session = Number(sheet.session.trim());
  if (
    year === null ||
    !Number.isInteger(session) ||
    session < 1 ||
    session > SESSIONS_PER_YEAR
  ) {
    return `intake ${label} cannot be read`;
  }
  const istYear = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
    }).format(now)
  );
  if (year > istYear + 1)
    return `intake ${label} is after ${istYear + 1}; check the tab name`;
  return null;
}

/** Holds every importable row back with a blocker, so an implausible intake is never written. */
export function holdBackForIntake(
  result: ReconcileResult,
  reason: string
): ReconcileResult {
  const flags = [
    ...result.flags,
    ...result.importable.map((r) => ({
      level: 'blocker' as const,
      sheet: r.sheet,
      rowNumber: r.rowNumber,
      student: r.name,
      code: 'implausible-intake',
      detail: reason,
    })),
  ];
  const heldBack = [
    ...result.heldBack,
    ...result.importable.map((r) => ({ row: r, reason })),
  ];
  const stats = Object.fromEntries(
    Object.keys(result.stats).map((k) => [k, 0])
  ) as ReconcileResult['stats'];
  return {
    importable: [],
    heldBack,
    flags,
    stats: { ...stats, parsed: result.stats.parsed, heldBack: heldBack.length },
  };
}
