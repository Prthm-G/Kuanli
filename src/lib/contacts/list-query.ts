import type { SupabaseClient } from '@supabase/supabase-js';

import { applyContactTab, type ContactTab } from './tab-filter';

export interface ContactListParams {
  tab: ContactTab;
  tagIds: string[];
  term: string;
  from: number;
  to: number;
}

/**
 * One page of the Contacts list, with the tab, tags and search all applied by
 * the server so the exact count is the true total. Tags use an inner join on
 * contact_tags: PostgREST returns one row per contact having ANY selected tag
 * (the embed is aggregated, never multiplied). Ordered newest first with an id
 * tie-breaker, the same order as the filter_contacts_by_tags RPC, so pages
 * never repeat or skip a row.
 */
export function contactListQuery(
  supabase: SupabaseClient,
  { tab, tagIds, term, from, to }: ContactListParams
) {
  const withTags = tagIds.length > 0;
  let query = supabase
    .from('contacts')
    .select(withTags ? '*, contact_tags!inner(tag_id)' : '*', {
      count: 'exact',
    })
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })
    .range(from, to);

  if (withTags) query = query.in('contact_tags.tag_id', tagIds);
  query = applyContactTab(query, tab);

  if (term) {
    const like = `%${term}%`;
    query = query.or(`name.ilike.${like},phone.ilike.${like},email.ilike.${like}`);
  }
  return query;
}

/** Rows without the contact_tags join column, so they stay plain contacts. */
export function withoutTagJoin<T extends object>(
  rows: (T & { contact_tags?: unknown })[]
): T[] {
  return rows.map((row) => {
    const contact = { ...row };
    delete contact.contact_tags;
    return contact;
  });
}
