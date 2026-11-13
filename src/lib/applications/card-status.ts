import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Checklist state of one application, as returned by the `application_card_status`
 * RPC (migration 096). The RPC reads the same predicates `advance_application`
 * moves cards by, so a chip never disagrees with the auto-move.
 */
export type CardStatus = {
  details: boolean;
  appFee: boolean;
  provisional: boolean;
  form: boolean;
  docsUploaded: number;
  docsRequired: number;
  courseFee: boolean;
  registration: boolean;
  hasPlan: boolean;
  reversed: boolean;
};

export type CardChip = { label: string; tone: 'done' | 'todo' | 'warn' };

type Raw = {
  contact_id: string;
  details: boolean | null;
  app_fee: boolean | null;
  provisional: boolean | null;
  form: boolean | null;
  docs_uploaded: number | null;
  docs_required: number | null;
  course_fee: boolean | null;
  registration: boolean | null;
  has_plan: boolean | null;
  reversed: boolean | null;
};

export function toCardStatus(row: Omit<Raw, 'contact_id'> & { contact_id?: string }): CardStatus {
  return {
    details: !!row.details,
    appFee: !!row.app_fee,
    provisional: !!row.provisional,
    form: !!row.form,
    docsUploaded: row.docs_uploaded ?? 0,
    docsRequired: row.docs_required ?? 0,
    courseFee: !!row.course_fee,
    registration: !!row.registration,
    hasPlan: !!row.has_plan,
    reversed: !!row.reversed,
  };
}

/** One RPC call per board load; keyed by contact_id. Contacts without an application have no entry. */
export async function loadCardStatuses(
  supabase: SupabaseClient,
  accountId: string
): Promise<Map<string, CardStatus>> {
  const { data, error } = await supabase.rpc('application_card_status', {
    p_account_id: accountId,
  });
  if (error) throw new Error(`Card status query failed: ${error.message}`);
  return new Map(((data ?? []) as Raw[]).map((r) => [r.contact_id, toCardStatus(r)]));
}

const ADMISSIONS_STAGES = new Set([
  'Counselor Active',
  'Application Started',
  'Provisional ID',
  'Form & Documents',
  'Fee Submitted',
  'Enrolled',
]);

/**
 * Chips for a board card: what is done, what is next, and what needs a person.
 * Before Counselor Active and on closed cards (Lost, Not Interested) there are none.
 */
export function cardChips(status: CardStatus, stageName: string): CardChip[] {
  if (!ADMISSIONS_STAGES.has(stageName)) return [];
  const chips: CardChip[] = [];
  const yes = (label: string, done: boolean) => chips.push({ label, tone: done ? 'done' : 'todo' });
  const docs = () => {
    if (status.docsRequired > 0) {
      yes(`docs ${status.docsUploaded}/${status.docsRequired}`, status.docsUploaded >= status.docsRequired);
    }
  };

  switch (stageName) {
    case 'Counselor Active':
      yes('details', status.details);
      yes('app fee', status.appFee);
      break;
    case 'Application Started':
      yes('provisional ID', status.provisional);
      break;
    case 'Provisional ID':
    case 'Form & Documents':
      if (!status.form) yes('form', false);
      docs();
      yes(status.courseFee ? 'fee received' : 'fee pending', status.courseFee);
      break;
    case 'Fee Submitted':
      docs();
      yes('registration', status.registration);
      break;
    default:
      break;
  }

  if (status.registration && !status.hasPlan) chips.push({ label: 'fee plan missing', tone: 'warn' });
  if (status.reversed) chips.push({ label: 'fee reversed', tone: 'warn' });
  return chips;
}
