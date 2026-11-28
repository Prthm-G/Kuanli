/** Pure rules for the sidebar's Application panel. */

export interface PanelFields {
  fatherName: string;
  program: string;
  university: string;
  specialization: string;
  universityAppNumber: string;
  provisionalAppId: string;
  registrationNumber: string;
}

const EXCLUDED_STAGES = new Set(['Lost', 'Not Interested']);

/**
 * The panel is shown for every deal that sits on a board with an Application
 * Started stage, except Lost and Not Interested. Details punched plus a
 * reported application fee is what moves a card from New Lead..Counselor
 * Active into Application Started, so the inputs must be reachable before it.
 */
export function showsApplicationPanel(
  deals: Array<{ pipeline_id: string; stage?: { name: string } | null }>,
  stages: Array<{ pipeline_id: string; name: string }>
): boolean {
  return deals.some(
    (d) =>
      d.stage != null &&
      !EXCLUDED_STAGES.has(d.stage.name) &&
      stages.some(
        (s) =>
          s.pipeline_id === d.pipeline_id && s.name === 'Application Started'
      )
  );
}

/**
 * After a button saves, take the server's values only for fields the
 * counsellor has not touched. `baseline` is what the form last loaded from the
 * server; a field that differs from it is unsaved typing and is kept.
 */
export function mergeServerFields(
  current: PanelFields,
  baseline: PanelFields,
  fresh: PanelFields
): PanelFields {
  const out = { ...fresh };
  for (const k of Object.keys(current) as Array<keyof PanelFields>) {
    if (current[k].trim() !== baseline[k].trim()) out[k] = current[k];
  }
  return out;
}

export type GateKey = 'father_name' | 'program' | 'university' | 'email';

/** Counsellor-facing names for the keys the database gate reports. */
export const GATE_LABELS: Record<GateKey, string> = {
  father_name: "Father's name",
  program: 'Program',
  university: 'University',
  email: 'Email',
};

const GATE_KEYS = Object.keys(GATE_LABELS) as GateKey[];

const PLACEHOLDER_LOCALS = new Set([
  'na',
  'n.a',
  'none',
  'test',
  'abc',
  'xyz',
  'noemail',
  'nomail',
  'no',
  'nil',
  'null',
  'demo',
  'sample',
]);

/** Client mirror of public.is_placeholder_email (migration 104). Keep them identical. */
export function isPlaceholderEmail(email: string): boolean {
  const t = email.trim();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(t)) return true;
  const local = t.toLowerCase().split('@')[0];
  return PLACEHOLDER_LOCALS.has(local) || /^(.)\1*$/.test(local);
}

/** What the database would reject "Details punched on portal" for, in the gate's order. */
export function punchedGateMissing(f: {
  fatherName: string;
  program: string;
  university: string;
  email: string;
}): GateKey[] {
  const out: GateKey[] = [];
  if (f.fatherName.trim() === '') out.push('father_name');
  if (f.program.trim() === '') out.push('program');
  if (f.university.trim() === '') out.push('university');
  if (isPlaceholderEmail(f.email)) out.push('email');
  return out;
}

/** Reads the gate's `missing: a,b` error; null for any other message. */
export function parseGateError(message: string): GateKey[] | null {
  const m = /^missing:\s*([a-z_,\s]+)$/.exec(message.trim());
  if (!m) return null;
  const keys = m[1]
    .split(',')
    .map((k) => k.trim())
    .filter((k): k is GateKey => (GATE_KEYS as string[]).includes(k));
  return keys.length > 0 ? keys : null;
}
