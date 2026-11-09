import type { Conversation } from '@/types';

/**
 * The inbox number filter and per-chat number label, for the owner and admins
 * (migration 094: only they can see chats on counsellor numbers). Counsellor
 * numbers are named after the counsellor, the main number is "Bot".
 */
export interface NumberConfigRow {
  phone_number_id: string | null;
  display_phone_number: string | null;
  is_primary: boolean | null;
}
export interface CounsellorNumberRow {
  phone_number_id: string | null;
  display_name: string;
}
export interface NumberOption {
  value: string;
  label: string;
}

export function numberLabelsFor(
  configs: readonly NumberConfigRow[],
  counsellors: readonly CounsellorNumberRow[]
): Record<string, string> {
  const named = new Map(
    counsellors
      .filter((c) => c.phone_number_id)
      .map((c) => [c.phone_number_id as string, c.display_name])
  );
  const labels: Record<string, string> = {};
  for (const r of configs) {
    if (!r.phone_number_id) continue;
    labels[r.phone_number_id] =
      named.get(r.phone_number_id) ??
      (named.size > 0 && r.is_primary
        ? 'Bot'
        : r.display_phone_number || r.phone_number_id);
  }
  return labels;
}

/** All numbers, Bot, then each linked counsellor number. Empty when there is none to tell apart. */
export function numberFilterOptions(
  counsellors: readonly CounsellorNumberRow[]
): NumberOption[] {
  const linked = counsellors
    .filter((c) => c.phone_number_id)
    .map((c) => ({ value: c.phone_number_id as string, label: c.display_name }))
    .sort((a, b) => a.label.localeCompare(b.label));
  if (linked.length === 0) return [];
  return [
    { value: 'all', label: 'All numbers' },
    { value: 'bot', label: 'Bot' },
    ...linked,
  ];
}

/** "bot" is every chat off the counsellor numbers (old bot numbers too); a phone_number_id keeps that number. */
export function filterByNumber(
  list: Conversation[],
  filter: string,
  counsellorIds: ReadonlySet<string>
): Conversation[] {
  if (filter === 'all') return list;
  if (filter === 'bot') {
    return list.filter(
      (c) => !c.phone_number_id || !counsellorIds.has(c.phone_number_id)
    );
  }
  return list.filter((c) => c.phone_number_id === filter);
}
