/** The six-step admissions journey shown on every student (spec R1b "Journey bar"), from the deal's stage name. */
export const JOURNEY_STEPS = [
  'New/Qualified',
  'Application Started',
  'Provisional ID',
  'Form & Documents',
  'Fee Submitted',
  'Enrolled',
] as const;
export type ClosedStage = 'Lost' | 'Not Interested';
export interface JourneyPosition {
  step: number | null;
  closed: ClosedStage | null;
}

const STEP_OF = new Map<string, number>([
  ['New Lead', 0],
  ['Engaged', 0],
  ['Qualified', 0],
  ['Counselor Active', 0],
  ['Application Started', 1],
  ['Provisional ID', 2],
  ['Form & Documents', 3],
  ['Fee Submitted', 4],
  ['Enrolled', 5],
]);

export function journeyPosition(
  stageName: string | null | undefined
): JourneyPosition {
  if (stageName === 'Lost' || stageName === 'Not Interested')
    return { step: null, closed: stageName };
  return {
    step: (stageName != null ? STEP_OF.get(stageName) : undefined) ?? null,
    closed: null,
  };
}

/** The deal whose stage the header shows: the furthest open deal, latest update first; else the latest closed one. */
export function pickCurrentDeal<
  T extends {
    stage?: { name: string } | null;
    updated_at?: string;
    created_at?: string;
  },
>(deals: T[]): T | null {
  if (deals.length === 0) return null;
  const when = (d: T) => d.updated_at ?? d.created_at ?? '';
  const open = deals.filter(
    (d) => journeyPosition(d.stage?.name).closed === null
  );
  const pool = open.length > 0 ? open : deals;
  return [...pool].sort(
    (a, b) =>
      (journeyPosition(b.stage?.name).step ?? -1) -
        (journeyPosition(a.stage?.name).step ?? -1) ||
      when(b).localeCompare(when(a))
  )[0];
}
