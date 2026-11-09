import { isPhoneNumberAiDisabled } from './ai-disabled';

/**
 * What a business number is, for the webhook (migration 094).
 *
 * A counsellor number is any number ever set in `counsellors.phone_number_id`
 * (`counsellor_number_history`, kept by a trigger): a counsellor's own
 * WhatsApp Business number on coexistence. Its chats are for the owner and
 * admins only (RLS, migration 094), the bot never answers there, and Kuanli
 * never sends there on its own. Read from the database on every change, so
 * linking a number in `counsellors` is all it takes; no `.env` edit. Unlinking
 * it later does not hand its chats to the bot.
 *
 * `aiDisabled` also covers AI_DISABLED_PHONE_NUMBER_IDS, which keeps working
 * for numbers that are not counsellor numbers (a number being wound down).
 */
export interface NumberPolicy {
  counsellorNumber: boolean;
  aiDisabled: boolean;
}

/**
 * In the error a failed lookup throws. The counsellor-number save script also
 * looks for it in the running build, to know this rule is deployed.
 */
export const NUMBER_POLICY_MARKER = 'kuanli-number-policy-db-v2';

// The slice of the Supabase client this needs, so tests can stand it in.
export interface CounsellorLookupClient {
  from(table: 'counsellor_number_history'): {
    select(columns: string): {
      eq(
        column: 'phone_number_id',
        value: string
      ): {
        limit(n: number): PromiseLike<{ data: unknown; error: unknown }>;
      };
    };
  };
}

/**
 * Fails closed: when the lookup errors this throws, so the caller stores and
 * forwards nothing for the change, and the webhook inbox (migration 084)
 * replays it later. A message never reaches the bot because a read failed.
 */
export async function loadNumberPolicy(
  db: CounsellorLookupClient,
  phoneNumberId: string,
  envList: string | undefined = process.env.AI_DISABLED_PHONE_NUMBER_IDS
): Promise<NumberPolicy> {
  let rows: unknown[];
  try {
    const { data, error } = await db
      .from('counsellor_number_history')
      .select('phone_number_id')
      .eq('phone_number_id', phoneNumberId)
      .limit(1);
    if (error) {
      throw new Error((error as { message?: string }).message ?? String(error));
    }
    // No error but no rows array either is not "not a counsellor number".
    if (!Array.isArray(data)) throw new Error('the lookup returned no rows');
    rows = data;
  } catch (err) {
    throw new Error(
      `${NUMBER_POLICY_MARKER}: counsellor lookup failed for ${phoneNumberId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  const counsellorNumber = rows.length > 0;
  return {
    counsellorNumber,
    aiDisabled:
      counsellorNumber || isPhoneNumberAiDisabled(phoneNumberId, envList),
  };
}

/**
 * What an inbound message on that number sets off.
 *  - forwardToBot: the n8n forward (the AI). Off on a paused chat and on any
 *    AI-disabled number.
 *  - runAutomations: Kuanli's own flows and automations. They send through
 *    the API from the chat's number, so never on a counsellor number.
 *  - markArrival: a lead's message on a counsellor number marks them reached
 *    (mark_counsellor_reached is idempotent and checks the number itself).
 *  - mirrorMedia: the chat-media copy. That bucket is readable by every member,
 *    so a counsellor number keeps Meta's link only (via the media proxy).
 */
export function inboundActions(
  policy: NumberPolicy,
  o: { botActive: boolean | null | undefined; mirrorSetting: boolean }
) {
  return {
    forwardToBot: o.botActive !== false && !policy.aiDisabled,
    runAutomations: !policy.counsellorNumber,
    markArrival: policy.aiDisabled,
    mirrorMedia: o.mirrorSetting && !policy.counsellorNumber,
  };
}
