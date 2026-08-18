import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * A whatsapp_config row. Only the fields callers actually read are typed; the
 * resolver selects `*` so the full row (including `access_token`, which callers
 * pass to `decrypt`) is present at runtime.
 */
export interface WhatsappConfigRow {
  id: string
  account_id: string
  phone_number_id: string
  access_token: string
  waba_id: string | null
  verify_token: string | null
  status: string
  is_primary: boolean
  [key: string]: unknown
}

/**
 * Resolve the whatsapp_config row a given conversation must send from.
 *
 * Multi-number accounts (migration 034) can own more than one whatsapp_config
 * row. Every conversation is tagged with the business `phone_number_id` it
 * belongs to (set on inbound by the webhook), so a reply always leaves from the
 * same number the lead is talking to.
 *
 * Falls back to the account's primary config when the conversation has no tag
 * yet (a thread created before 034's backfill, or an edge case). Throws when
 * the account has no WhatsApp config at all.
 *
 * `db` must be a service-role client (these call sites bypass RLS by design);
 * `accountId` is still passed and matched so a config from another tenant can
 * never be selected.
 */
export async function getConfigForConversation(
  db: SupabaseClient,
  conversationId: string,
  accountId: string,
): Promise<WhatsappConfigRow> {
  const { data: conv } = await db
    .from('conversations')
    .select('phone_number_id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()

  const phoneNumberId = (conv?.phone_number_id ?? null) as string | null
  if (phoneNumberId) {
    const { data: cfg } = await db
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .eq('phone_number_id', phoneNumberId)
      .maybeSingle()
    if (cfg) return cfg as WhatsappConfigRow
  }

  // No usable tag (or the tagged number's config was removed): fall back to the
  // account default rather than failing the send.
  return getPrimaryConfig(db, accountId)
}

/**
 * The account's default whatsapp_config row, for account/WABA-level operations
 * (template submit/sync, broadcasts) and as the fallback for conversations with
 * no number tag. Prefers the row flagged `is_primary`, else the oldest row.
 * Throws when the account has none.
 *
 * Replaces the old `.eq('account_id', accountId).single()` pattern, which threw
 * PGRST116 ("multiple rows") once an account owned more than one number.
 */
export async function getPrimaryConfig(
  db: SupabaseClient,
  accountId: string,
): Promise<WhatsappConfigRow> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .order('is_primary', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (error || !data) {
    throw new Error('WhatsApp not configured for this account')
  }
  return data as WhatsappConfigRow
}
