import { isExitStage } from '@/lib/pipelines/closed';

type Stage = { name: string; position: number };

/**
 * Whether the admission import moves an existing card to the row's stage.
 * Forward only, mirroring lifecycle_sweep, so a card is never dragged back.
 * A Lost or Not Interested card never moves: moving one to Enrolled reports a
 * Purchase to Meta, so it is a person's single, deliberate act. The import
 * lists those students instead (listExitCards).
 */
export function importMovesDeal(current: Stage, target: Stage): boolean {
  if (isExitStage(current.name)) return false;
  return current.position < target.position;
}

type DealRow = {
  id: string;
  contact_id: string;
  stage_id: string;
  created_at: string | null;
};

/**
 * The card the import works on for each contact: the newest on the board, an
 * undated one counting as oldest. The write and the dry-run both use it.
 */
export function newestDealByContact<T extends DealRow>(
  deals: ReadonlyArray<T>
): Map<string, T> {
  const at = (d: DealRow) =>
    d.created_at ? Date.parse(d.created_at) : -Infinity;
  const out = new Map<string, T>();
  for (const d of deals) {
    const best = out.get(d.contact_id);
    if (!best || at(d) > at(best)) out.set(d.contact_id, d);
  }
  return out;
}

/** A student the import leaves alone because their card is Lost or Not Interested. */
export type ExitCard = {
  student: string;
  row: number;
  /** The card's stage now: Lost or Not Interested. */
  card: string;
  /** Where the sheet puts the student: where a person may move the card. */
  sheetStage: string;
  /** Kuanli's LD number. */
  ldNumber: string | null;
  /** The university's roll (registration) number from the sheet. */
  rollNumber: string | null;
};

export function exitCard(
  row: {
    name: string;
    rowNumber: number;
    stage: string;
    universityRollNumber: string;
  },
  card: string,
  ldNumber: string | null
): ExitCard {
  return {
    student: row.name,
    row: row.rowNumber,
    card,
    sheetStage: row.stage,
    ldNumber,
    rollNumber: row.universityRollNumber || null,
  };
}

/**
 * The students whose newest card is Lost or Not Interested, once per contact.
 * `contactByPhone` maps import phones to contacts; `stageByContact` holds the
 * stage name of each contact's newest card.
 */
export function listExitCards(
  rows: ReadonlyArray<{
    name: string;
    rowNumber: number;
    importPhone: string;
    universityRollNumber: string;
    stage: string;
  }>,
  contactByPhone: ReadonlyMap<string, { id: string; ldNumber: string | null }>,
  stageByContact: ReadonlyMap<string, string>
): ExitCard[] {
  const seen = new Set<string>();
  const out: ExitCard[] = [];
  for (const r of rows) {
    const contact = r.importPhone
      ? contactByPhone.get(r.importPhone)
      : undefined;
    const card = contact ? stageByContact.get(contact.id) : undefined;
    if (!contact || !card || !isExitStage(card) || seen.has(contact.id))
      continue;
    seen.add(contact.id);
    out.push(exitCard(r, card, contact.ldNumber));
  }
  return out;
}
