/** Pure rules for the sidebar's Application panel. */

export interface PanelFields {
  fatherName: string;
  program: string;
  specialization: string;
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
