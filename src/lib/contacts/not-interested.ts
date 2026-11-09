import type { SupabaseClient } from '@supabase/supabase-js';

import type { Contact } from '@/types';

/**
 * Contacts "Not interested" tab (093): contacts with a deal in the Not
 * Interested stage, filtered, counted and paged on the server. The 093 trigger
 * moves every open deal of a contact there together, and the sweep moves them
 * back when the student writes, so "has a deal there" is the list.
 */
export async function loadNotInterestedContacts(
  supabase: SupabaseClient,
  opts: { from: number; to: number; term?: string; tagIds?: string[] }
): Promise<{
  rows: Contact[];
  count: number;
  error: { message: string } | null;
}> {
  const withTags = (opts.tagIds?.length ?? 0) > 0;
  let query = supabase
    .from('contacts')
    .select(
      '*, deals!inner(pipeline_stages!inner(name))' +
        (withTags ? ', contact_tags!inner(tag_id)' : ''),
      { count: 'exact' }
    )
    .eq('deals.pipeline_stages.name', 'Not Interested');
  // Any of the chosen tags, as on the other tabs.
  if (withTags) query = query.in('contact_tags.tag_id', opts.tagIds!);
  const term = opts.term?.trim();
  if (term) {
    const like = `%${term}%`;
    query = query.or(
      `name.ilike.${like},phone.ilike.${like},email.ilike.${like}`
    );
  }
  const { data, count, error } = await query
    .order('created_at', { ascending: false })
    // Many contacts share one created_at (bulk imports): id keeps pages stable,
    // as in contactListQuery.
    .order('id', { ascending: true })
    .range(opts.from, opts.to);
  if (error) return { rows: [], count: 0, error };
  // Drop the join columns, so a row handed to the edit form is a plain contact.
  const rows = (
    (data ?? []) as unknown as (Contact & {
      deals?: unknown;
      contact_tags?: unknown;
    })[]
  ).map((r) => {
    const c = { ...r };
    delete c.deals;
    delete c.contact_tags;
    return c as Contact;
  });
  return { rows, count: count ?? 0, error: null };
}
