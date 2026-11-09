import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createHmac } from 'node:crypto';
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption';
import { getMediaUrl } from '@/lib/whatsapp/meta-api';
import { mirrorInboundMedia } from '@/lib/whatsapp/mirror-inbound-media';
import {
  botForwardFor,
  classifyInboundMessage,
  FIRST_CONTACT_GREETING,
  type ClassifiableInboundMessage,
} from '@/lib/whatsapp/inbound-classification';
import {
  maskDigitsInText,
  maskPhone,
  normalizePhone,
} from '@/lib/whatsapp/phone-utils';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { pricingRow, type StatusPricing } from '@/lib/whatsapp/billable';
import {
  inboundActions,
  loadNumberPolicy,
  type NumberPolicy,
} from '@/lib/whatsapp/number-policy';
import {
  HISTORY_DECLINED_CODE,
  HISTORY_MEDIA_PLACEHOLDER,
  historyScopeOf,
  planHistory,
  summarizeHistoryParts,
  type HistoryScope,
  type HistoryValue,
  type PlannedHistoryMessage,
} from '@/lib/whatsapp/history-sync';
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook';
import {
  normalizeMessageStatus,
  statusesOverwritableBy,
} from '@/lib/whatsapp/message-status';
import type { MessageStatus } from '@/types';

// SP3b: mark the lead's assignment reached and keep the bot quiet on their
// 79019 chat. Never blocks the inbound (already stored): failures are logged.
async function markCounsellorArrival(contactId: string, phoneNumberId: string) {
  try {
    const { data: reached, error } = await supabaseAdmin().rpc(
      'mark_counsellor_reached',
      { p_contact_id: contactId, p_phone_number_id: phoneNumberId }
    );
    if (error) {
      console.error(
        '[webhook] failed to mark counsellor arrival for contact',
        contactId,
        error
      );
    } else if (typeof reached === 'number' && reached > 0) {
      console.log(
        '[webhook] lead reached their counsellor; assignments marked:',
        reached,
        'contact',
        contactId
      );
    }
  } catch (err) {
    console.error(
      '[webhook] mark_counsellor_reached threw for contact',
      contactId,
      err
    );
  }
}

// ===== n8n WEBHOOK FORWARDING =====
async function forwardToN8n(eventType: string, data: Record<string, unknown>) {
  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  const secret = process.env.N8N_WEBHOOK_SECRET;
  if (!webhookUrl) return;

  try {
    const timestamp = new Date().toISOString();
    const body = JSON.stringify({
      event_type: eventType,
      timestamp,
      data,
    });
    const signature = secret
      ? `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`
      : '';
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Timestamp': timestamp,
        'X-Webhook-Signature': signature,
        // Kept temporarily for compatibility until the active n8n workflow
        // verifies the signature above and the bearer header can be removed.
        'X-Webhook-Secret': secret || '',
      },
      signal: AbortSignal.timeout(10_000),
      body,
    });
    if (!response.ok) {
      throw new Error(`n8n returned HTTP ${response.status}`);
    }
  } catch (err) {
    console.error('[n8n forward] Failed:', err);
  }
}

// Lazy-initialized to avoid build-time crash when env vars are missing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null;
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _adminClient;
}

interface WhatsAppMessage extends ClassifiableInboundMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: {
    id: string;
    mime_type: string;
    caption?: string;
    file_size?: number;
  };
  video?: {
    id: string;
    mime_type: string;
    caption?: string;
    file_size?: number;
  };
  document?: {
    id: string;
    mime_type: string;
    filename?: string;
    caption?: string;
    file_size?: number;
  };
  audio?: { id: string; mime_type: string; file_size?: number };
  sticker?: { id: string; mime_type: string };
  location?: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
  reaction?: { message_id: string; emoji: string };
  interactive?: {
    type: 'button_reply' | 'list_reply';
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  context?: { id: string };
  // Click-to-WhatsApp ad context. Meta attaches this to the FIRST inbound
  // message of a conversation that started from an ad, and only that one, so
  // whatever is not captured here is not recoverable from a later message.
  // `ctwa_clid` (the click id minted at ad tap) and `source_id` (the ad id) are
  // the pair that ties an admission back to the ad that paid for it. Every
  // field is optional: Meta sends only the ones the ad actually had.
  referral?: {
    headline?: string;
    body?: string;
    source_url?: string;
    source_id?: string;
    source_type?: string;
    ctwa_clid?: string;
    media_type?: string;
    image_url?: string;
    video_url?: string;
    thumbnail_url?: string;
  };
}

// A message sent from the business's WhatsApp Business app (or a linked
// companion device), mirrored to us via the `smb_message_echoes` webhook
// field. Same per-type content shape as WhatsAppMessage, plus the
// customer's number in `to` (echoes carry no `contacts[]`/profile name).
interface WhatsAppMessageEcho extends WhatsAppMessage {
  to: string;
}

// Outgoing message status. `errors` is present only on a send or delivery
// failure, and it is the only thing that says WHY: without it a row reads
// 'failed' with no cause. Branch on `code`; per Meta's error codes reference
// `title` and `message` carry the same value and titles are on a deprecation
// path, so `error_data.details` is the string worth keeping.
interface WhatsAppStatus {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
  pricing?: StatusPricing;
  errors?: Array<{
    code: number;
    title?: string;
    message?: string;
    error_data?: { details?: string };
    href?: string;
  }>;
}

interface WhatsAppWebhookEntry {
  id: string;
  changes: Array<{
    value: {
      messaging_product: string;
      metadata: {
        display_phone_number: string;
        phone_number_id: string;
      };
      contacts?: Array<{
        profile: { name: string };
        wa_id: string;
      }>;
      messages?: WhatsAppMessage[];
      message_echoes?: WhatsAppMessageEcho[];
      statuses?: WhatsAppStatus[];
    };
    field: string;
  }>;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const mode = searchParams.get('hub.mode');
    const challenge = searchParams.get('hub.challenge');
    const verifyToken = searchParams.get('hub.verify_token');

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 }
      );
    }

    const { data: configs, error: configError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('id, verify_token');

    if (configError || !configs) {
      return NextResponse.json(
        { error: 'Verification failed' },
        { status: 403 }
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let matchedConfig: any = null;
    for (const config of configs) {
      if (!config.verify_token) continue;
      try {
        if (decrypt(config.verify_token) === verifyToken) {
          matchedConfig = config;
          break;
        }
      } catch {}
    }

    if (matchedConfig) {
      if (isLegacyFormat(matchedConfig.verify_token)) {
        void supabaseAdmin()
          .from('whatsapp_config')
          .update({ verify_token: encrypt(verifyToken) })
          .eq('id', matchedConfig.id);
      }
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // Allow Meta's app-level callback verification before a tenant config
    // exists (and keep the configured token in server-side environment only).
    const appVerifyToken =
      process.env.AURETRIS_WHATSAPP_VERIFY_TOKEN ??
      process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    if (appVerifyToken && appVerifyToken === verifyToken) {
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 }
    );
  } catch (error) {
    console.error('[webhook verification] failed:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-hub-signature-256');

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    console.warn('[webhook] rejected request with invalid signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let body: { entry?: WhatsAppWebhookEntry[] };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // KB-WEBHOOK-INBOX-084: store the payload before the 200, so a crash or a
  // redeploy mid-processing can no longer lose it (Meta does not resend after
  // a 200). If the store itself fails we still process, as before.
  const inboxId = await saveToInbox(body);
  processWebhook(body)
    .then(() => settleInbox(inboxId))
    .catch((error) => {
      console.error('Error processing webhook:', error);
      return settleInbox(inboxId, error);
    });
  maybeReplayInbox();

  return NextResponse.json({ status: 'received' }, { status: 200 });
}

// ---- webhook inbox (migration 084) ----------------------------------------
// Replay is safe: inbound messages are deduplicated on the wamid, statuses and
// echoes are upserts. Rows left unprocessed (crash, redeploy, thrown error) are
// replayed by the next webhook after the module loads, then at most every 2 min.
const INBOX_REPLAY_EVERY_MS = 2 * 60 * 1000;
let lastInboxReplay = 0;

async function saveToInbox(body: unknown): Promise<number | null> {
  try {
    const { data, error } = await supabaseAdmin()
      .from('webhook_inbox')
      .insert({ body })
      .select('id')
      .single();
    if (error) {
      console.error('[webhook] inbox insert failed:', error.message);
      return null;
    }
    return (data as { id: number }).id;
  } catch (error) {
    console.error('[webhook] inbox insert failed:', error);
    return null;
  }
}

async function settleInbox(id: number | null, failure?: unknown) {
  if (id == null) return;
  const patch = failure
    ? {
        last_error: String(
          failure instanceof Error ? failure.message : failure
        ).slice(0, 500),
      }
    : { processed_at: new Date().toISOString() };
  const { error } = await supabaseAdmin()
    .from('webhook_inbox')
    .update(patch)
    .eq('id', id);
  if (error) console.error('[webhook] inbox update failed:', error.message);
}

async function replayInbox() {
  const { data, error } = await supabaseAdmin().rpc('claim_webhook_inbox', {
    p_limit: 20,
    p_min_age_seconds: 120,
  });
  if (error) {
    console.error('[webhook] inbox claim failed:', error.message);
    return;
  }
  for (const row of (data ?? []) as {
    id: number;
    body: { entry?: WhatsAppWebhookEntry[] };
  }[]) {
    try {
      await processWebhook(row.body);
      await settleInbox(row.id);
      console.log('[webhook] replayed inbox row', row.id);
    } catch (err) {
      console.error('[webhook] inbox replay failed for row', row.id, err);
      await settleInbox(row.id, err);
    }
  }
}

function maybeReplayInbox() {
  const now = Date.now();
  if (now - lastInboxReplay < INBOX_REPLAY_EVERY_MS) return;
  lastInboxReplay = now;
  replayInbox().catch((error) =>
    console.error('[webhook] inbox replay failed:', error)
  );
}

async function processWebhook(body: { entry?: WhatsAppWebhookEntry[] }) {
  if (!body.entry) return;

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      if (isTemplateWebhookField(change.field)) {
        await handleTemplateWebhookChange(
          { field: change.field, value: change.value as unknown },
          supabaseAdmin()
        );
        continue;
      }

      // Messages sent from the business's WhatsApp Business app (Coexistence).
      // No `messages`/`contacts` keys are present on this field, so this
      // must be handled before the `!value.messages || !value.contacts`
      // guard below — otherwise it's silently dropped.
      if (change.field === 'smb_message_echoes') {
        await processEchoChange(change.value);
        continue;
      }

      // Coexistence chat history (migration 094): past chats of a number,
      // once, after onboarding. Its media follow-ups carry `messages` too, so
      // this must come before the inbound path below.
      if (change.field === 'history') {
        await processHistoryChange(change.value as HistoryValue);
        continue;
      }

      const value = change.value;

      if (value.statuses) {
        for (const status of value.statuses) {
          await handleStatusUpdate(status, value.metadata.phone_number_id);
        }
      }

      if (!value.messages || !value.contacts) continue;

      const phoneNumberId = value.metadata.phone_number_id;

      const { data: configRows, error: configError } = await supabaseAdmin()
        .from('whatsapp_config')
        .select('*')
        .eq('phone_number_id', phoneNumberId);

      if (configError) {
        console.error(
          '[webhook] whatsapp_config lookup failed for phone_number_id',
          phoneNumberId,
          configError
        );
        continue;
      }
      if (!configRows || configRows.length === 0) continue;
      if (configRows.length > 1) {
        console.error(
          '[webhook] duplicate whatsapp_config rows for phone_number_id',
          phoneNumberId,
          '- owners:',
          configRows.map((c: { user_id: string }) => c.user_id)
        );
        continue;
      }

      const config = configRows[0];
      // Counsellor number or not (migration 094). Throws when the lookup
      // fails: nothing below runs, nothing reaches n8n, and the webhook inbox
      // replays this delivery.
      const policy = await loadNumberPolicy(supabaseAdmin(), phoneNumberId);
      await backfillDisplayPhoneNumber(
        config,
        value.metadata.display_phone_number
      );
      const decryptedAccessToken = decrypt(config.access_token);

      for (let i = 0; i < value.messages.length; i++) {
        const message = value.messages[i];
        const contact = value.contacts[i] || value.contacts[0];

        await processMessage(
          message,
          contact,
          config.account_id,
          config.user_id,
          decryptedAccessToken,
          phoneNumberId,
          // Default ON: the bug being fixed is silent data loss, so an
          // account that never finds the setting should keep its
          // attachments rather than keep losing them.
          config.mirror_inbound_media !== false,
          policy
        );
      }
    }
  }
}

/**
 * Backfill whatsapp_config.display_phone_number from the webhook payload.
 *
 * Meta puts the human-readable number in `metadata.display_phone_number` on
 * every inbound change, but nothing read it. Migration 035 added the column and
 * only populates it when a number is saved through the settings form, so any
 * row predating that migration keeps a null and the inbox badge falls back to
 * the opaque phone_number_id (inbox/page.tsx). Filling it here is self-healing:
 * the next inbound message on a number fixes its own badge, and numbers added
 * later never develop the gap.
 *
 * The `.is(null)` predicate keeps this idempotent and race-safe, and the early
 * return means the common case costs no query at all.
 */
async function backfillDisplayPhoneNumber(
  config: { id: string; display_phone_number: string | null },
  displayPhoneNumber: string | undefined
) {
  if (config.display_phone_number || !displayPhoneNumber) return;

  const { error } = await supabaseAdmin()
    .from('whatsapp_config')
    .update({ display_phone_number: displayPhoneNumber })
    .eq('id', config.id)
    .is('display_phone_number', null);

  if (error) {
    console.error(
      '[webhook] failed to backfill display_phone_number for config',
      config.id,
      error
    );
  }
}

async function processEchoChange(
  value: WhatsAppWebhookEntry['changes'][number]['value']
) {
  const items = value.message_echoes;
  if (!items || items.length === 0) return;

  const phoneNumberId = value.metadata.phone_number_id;

  const { data: configRows, error: configError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('*')
    .eq('phone_number_id', phoneNumberId);

  if (configError) {
    console.error(
      '[webhook] whatsapp_config lookup failed for phone_number_id (echo)',
      phoneNumberId,
      configError
    );
    return;
  }
  if (!configRows || configRows.length === 0) return;
  if (configRows.length > 1) {
    console.error(
      '[webhook] duplicate whatsapp_config rows for phone_number_id (echo)',
      phoneNumberId,
      '- owners:',
      configRows.map((c: { user_id: string }) => c.user_id)
    );
    return;
  }

  const config = configRows[0];
  // Throws when the lookup fails, so a counsellor number's media never goes to
  // the shared bucket by mistake; the webhook inbox replays the delivery.
  const policy = await loadNumberPolicy(supabaseAdmin(), phoneNumberId);
  await backfillDisplayPhoneNumber(config, value.metadata.display_phone_number);
  const decryptedAccessToken = decrypt(config.access_token);

  // Isolated per item: one malformed/unexpected echo must not abort the
  // rest of this delivery's other changes (the route already returned its
  // 200 to Meta before processWebhook finishes running). Any failure is thrown
  // after the loop so the webhook inbox replays the delivery; echoes already
  // stored are skipped on the replay (wamid guard).
  let echoFailures = 0;
  for (const echo of items) {
    try {
      await processEchoItem(
        echo,
        config.account_id,
        config.user_id,
        decryptedAccessToken,
        phoneNumberId,
        inboundActions(policy, {
          botActive: null,
          mirrorSetting: config.mirror_inbound_media !== false,
        }).mirrorMedia,
        policy.counsellorNumber
      );
    } catch (err) {
      echoFailures += 1;
      console.error(
        '[webhook] failed to process smb_message_echoes item',
        echo.id,
        errorText(err)
      );
    }
  }
  if (echoFailures > 0) {
    throw new Error(
      `${echoFailures} smb_message_echoes item(s) not stored for ${phoneNumberId}`
    );
  }
}

async function processEchoItem(
  echo: WhatsAppMessageEcho,
  accountId: string,
  configOwnerUserId: string,
  accessToken: string,
  phoneNumberId: string,
  // Per-account opt-out for the media mirror (migration 051).
  mirrorMedia: boolean,
  // A counsellor number (094): a new contact gets no LD lead number.
  counsellorNumber: boolean
) {
  // No contacts[]/profile name on this field — resolve by phone alone.
  const customerPhone = normalizePhone(echo.to);

  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    customerPhone,
    '',
    'organic',
    counsellorNumber
  );
  // Thrown, not returned: the message is not stored yet, so the webhook inbox
  // replays the delivery (the wamid guard makes the replay safe). A contact
  // left without its chat would otherwise stay chatless.
  if (!contactOutcome) throw new Error('contact not found or created');
  const contactRecord = contactOutcome.contact;

  const conversation = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id,
    phoneNumberId
  );
  if (!conversation) throw new Error('conversation not found or created');

  const { contentText, mediaUrl, mediaType } = await parseMessageContent(
    echo,
    accessToken,
    mirrorMedia ? { accountId, folder: 'echo' } : null
  );

  const ALLOWED_CONTENT_TYPES = new Set([
    'text',
    'image',
    'document',
    'audio',
    'video',
    'location',
    'template',
    'interactive',
  ]);
  const contentType = ALLOWED_CONTENT_TYPES.has(echo.type)
    ? echo.type
    : echo.type === 'sticker'
      ? 'image'
      : 'text';

  const echoTimestamp = Number.parseInt(echo.timestamp, 10);
  const echoCreatedAt = Number.isFinite(echoTimestamp)
    ? new Date(echoTimestamp * 1000).toISOString()
    : new Date().toISOString();

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'agent',
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    media_type: mediaType,
    message_id: echo.id,
    status: 'sent',
    created_at: echoCreatedAt,
  });

  if (msgError) {
    if (isUniqueViolation(msgError)) {
      // Meta retries webhooks. The WAMID uniqueness guard makes a retry a
      // successful no-op instead of duplicating the mirrored message.
      return;
    }
    console.error(
      '[webhook] failed to insert smb_message_echoes message for conversation',
      conversation.id,
      msgError
    );
  }
}

// ---- coexistence chat history (migration 094) -------------------------------
// Meta sends a number's past chats once, in chunks, after the save script asks
// (smb_app_data, sync_type "history"). Each message is stored once (the wamid
// unique index), with its original time and who wrote it: the contact is
// 'customer', the business (the counsellor's app) is 'agent'. Nothing here
// reaches n8n, flows or automations, nothing is copied to the shared media
// bucket, and nothing marks a lead reached: these messages are from before the
// number was connected, mark_counsellor_reached would stamp now() as the
// arrival and queue an ad event for it, and an old chat can predate the
// assignment it would close. Live messages on the number mark arrival as usual.
// Only a counsellor number's history is stored: anything else is logged and
// dropped (the bot number's past chats are not ours to import). A thread that
// cannot be stored is logged and the rest of the chunk is kept; only a chunk
// where nothing could be stored throws, so the webhook inbox replays it (what
// was stored is skipped on the replay).
const HISTORY_CONTENT_TYPES = new Set([
  'text',
  'image',
  'document',
  'audio',
  'video',
  'location',
  'template',
  'interactive',
]);
const historyContentType = (type: string) =>
  HISTORY_CONTENT_TYPES.has(type)
    ? type
    : type === 'sticker'
      ? 'image'
      : 'text';

async function processHistoryChange(value: HistoryValue) {
  const phoneNumberId = value.metadata?.phone_number_id;
  if (!phoneNumberId) return;

  const { parts, media } = planHistory(value);
  const summary = summarizeHistoryParts(parts);
  for (const d of summary.declined) {
    console.warn(
      '[webhook] history sync declined by the business for phone_number_id %s: code %s %s',
      phoneNumberId,
      d.code,
      d.details
    );
  }
  for (const p of parts) {
    if (p.kind === 'error' && p.code !== HISTORY_DECLINED_CODE) {
      console.error(
        '[webhook] history sync error for phone_number_id %s: code %s %s',
        phoneNumberId,
        p.code,
        p.details
      );
    }
  }
  const total =
    summary.chunks.reduce((n, c) => n + c.messages, 0) + media.length;
  if (total === 0) {
    if (summary.chunks.length > 0) {
      console.log(
        '[webhook] history for phone_number_id %s: %s, nothing to store',
        phoneNumberId,
        JSON.stringify(summary.chunks)
      );
    }
    return;
  }

  const { data: configRows, error: configError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('*')
    .eq('phone_number_id', phoneNumberId);
  if (configError) {
    // Thrown so the webhook inbox replays the chunk: history comes only once.
    throw new Error(
      `whatsapp_config lookup failed for history on ${phoneNumberId}: ${configError.message}`
    );
  }
  if (!configRows || configRows.length !== 1) {
    console.error(
      '[webhook] history for phone_number_id %s dropped: %d whatsapp_config rows',
      phoneNumberId,
      configRows?.length ?? 0
    );
    return;
  }
  const config = configRows[0];
  // Throws when the lookup fails (fail closed: nothing stored, the inbox replays).
  const policy = await loadNumberPolicy(supabaseAdmin(), phoneNumberId);
  if (!policy.counsellorNumber) {
    console.warn(
      '[webhook] history for phone_number_id %s dropped: not a counsellor number (%d messages)',
      phoneNumberId,
      total
    );
    return;
  }
  const accessToken = decrypt(config.access_token);
  // 094 whatsapp_config.history_scope: every 1:1 chat ('all', the default) or
  // only chats with someone already in Contacts ('known_contacts').
  const scope = historyScopeOf(config.history_scope);

  let stored = 0;
  let existed = 0;
  let failed = 0;
  let outOfScope = 0;
  for (const part of parts) {
    if (part.kind !== 'chunk') continue;
    for (const thread of part.threads) {
      try {
        const r = await storeHistoryThread(
          config,
          phoneNumberId,
          accessToken,
          thread.customerPhone,
          thread.messages,
          scope
        );
        stored += r.stored;
        existed += r.existed;
        outOfScope += r.outOfScope;
      } catch (err) {
        failed += thread.messages.length;
        // The error can quote the contact's number (a constraint's detail): masked.
        console.error(
          '[webhook] history thread not stored for phone_number_id',
          phoneNumberId,
          errorText(err)
        );
      }
    }
  }
  for (const item of media) {
    try {
      const r = await storeHistoryMedia(
        config,
        phoneNumberId,
        accessToken,
        item.customerPhone,
        item.message,
        scope
      );
      if (r === 'existed') existed += 1;
      else if (r === 'out_of_scope') outOfScope += 1;
      else stored += 1;
    } catch (err) {
      failed += 1;
      console.error(
        '[webhook] history media not stored for phone_number_id',
        phoneNumberId,
        item.message.message.id,
        errorText(err)
      );
    }
  }

  console.log(
    '[webhook] history for phone_number_id %s (scope %s): %s, media %d | stored %d, already there %d, not a known contact %d, failed %d',
    phoneNumberId,
    scope,
    JSON.stringify(summary.chunks),
    media.length,
    stored,
    existed,
    outOfScope,
    failed
  );
  if (failed > 0 && stored + existed + outOfScope === 0) {
    throw new Error(
      `history: none of ${failed} message(s) stored for ${phoneNumberId}; the inbox replays this chunk`
    );
  }
}

// For a log line: the error's text with any long digit run (a phone number)
// cut to its last 4 digits.
function errorText(err: unknown): string {
  const text =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : JSON.stringify(err);
  return maskDigitsInText(text ?? String(err));
}

// The chat for a history thread, or null when the scope is 'known_contacts'
// and the person is not in Contacts yet.
async function historyChat(
  config: { account_id: string; user_id: string },
  phoneNumberId: string,
  customerPhone: string,
  scope: HistoryScope
) {
  const phone = normalizePhone(customerPhone);
  if (scope === 'known_contacts') {
    const known = await findExistingContact(
      supabaseAdmin(),
      config.account_id,
      phone
    );
    if (!known) return null;
  }
  // A new contact is made through create_counsellor_number_contact: no LD
  // lead number, admins and the owner only (094) until they write elsewhere.
  const contactOutcome = await findOrCreateContact(
    config.account_id,
    config.user_id,
    phone,
    '',
    'organic',
    true
  );
  if (!contactOutcome) throw new Error('contact not found or created');
  const conversation = await findOrCreateConversation(
    config.account_id,
    config.user_id,
    contactOutcome.contact.id,
    phoneNumberId
  );
  if (!conversation) throw new Error('conversation not found or created');
  return conversation as { id: string };
}

async function historyRow(
  conversationId: string,
  planned: PlannedHistoryMessage,
  accessToken: string
) {
  const m = planned.message as unknown as WhatsAppMessage;
  let content: {
    contentText: string | null;
    mediaUrl: string | null;
    mediaType: string | null;
    interactiveReplyId: string | null;
  };
  let errorCode: number | null = null;
  let errorDetails: string | null = null;
  if (planned.placeholder) {
    content = {
      contentText: HISTORY_MEDIA_PLACEHOLDER,
      mediaUrl: null,
      mediaType: null,
      interactiveReplyId: null,
    };
  } else {
    const special =
      planned.senderType === 'customer' ? classifyInboundMessage(m) : null;
    if (special && !special.store) return null;
    content = special
      ? {
          contentText: special.contentText,
          mediaUrl: null,
          mediaType: null,
          interactiveReplyId: special.interactiveReplyId,
        }
      : await parseMessageContent(m, accessToken, null);
    errorCode = special?.errorCode ?? null;
    errorDetails = special?.errorDetails ?? null;
  }
  return {
    conversation_id: conversationId,
    sender_type: planned.senderType,
    content_type: planned.placeholder ? 'text' : historyContentType(m.type),
    content_text: content.contentText,
    media_url: content.mediaUrl,
    media_type: content.mediaType,
    message_id: m.id,
    status: planned.status,
    created_at: planned.createdAt,
    interactive_reply_id: content.interactiveReplyId,
    error_code: errorCode,
    error_details: errorDetails,
  };
}

async function storeHistoryThread(
  config: { account_id: string; user_id: string },
  phoneNumberId: string,
  accessToken: string,
  customerPhone: string,
  messages: PlannedHistoryMessage[],
  scope: HistoryScope
): Promise<{ stored: number; existed: number; outOfScope: number }> {
  const conversation = await historyChat(
    config,
    phoneNumberId,
    customerPhone,
    scope
  );
  if (!conversation)
    return { stored: 0, existed: 0, outOfScope: messages.length };

  // What a replay (or a retry from Meta) already stored.
  const ids = messages.map((m) => m.message.id);
  const already = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabaseAdmin()
      .from('messages')
      .select('message_id')
      .in('message_id', ids.slice(i, i + 200));
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as { message_id: string }[]) {
      already.add(r.message_id);
    }
  }

  const rows = [];
  for (const m of messages) {
    if (already.has(m.message.id)) continue;
    const row = await historyRow(conversation.id, m, accessToken);
    if (row) rows.push(row);
  }

  let stored = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabaseAdmin().from('messages').insert(batch);
    if (!error) {
      stored += batch.length;
      continue;
    }
    if (!isUniqueViolation(error)) throw new Error(error.message);
    // A concurrent replay stored some of these: one by one, skipping those.
    for (const row of batch) {
      const { error: oneError } = await supabaseAdmin()
        .from('messages')
        .insert(row);
      if (!oneError) stored += 1;
      else if (!isUniqueViolation(oneError)) throw new Error(oneError.message);
    }
  }
  return { stored, existed: already.size, outOfScope: 0 };
}

async function storeHistoryMedia(
  config: { account_id: string; user_id: string },
  phoneNumberId: string,
  accessToken: string,
  customerPhone: string,
  planned: PlannedHistoryMessage,
  scope: HistoryScope
): Promise<'filled' | 'stored' | 'existed' | 'out_of_scope'> {
  const m = planned.message as unknown as WhatsAppMessage;
  // No copy to the shared bucket: Meta's link through the media proxy only.
  const { contentText, mediaUrl, mediaType } = await parseMessageContent(
    m,
    accessToken,
    null
  );

  // The placeholder stored from the chunk, if it came first.
  const { data: filled, error: fillError } = await supabaseAdmin()
    .from('messages')
    .update({
      content_type: historyContentType(m.type),
      content_text: contentText,
      media_url: mediaUrl,
      media_type: mediaType,
    })
    .eq('message_id', m.id)
    .eq('content_text', HISTORY_MEDIA_PLACEHOLDER)
    .is('media_url', null)
    .select('id');
  if (fillError) throw new Error(fillError.message);
  if (filled && filled.length > 0) return 'filled';

  // The media came first (chunks are not ordered) or is already stored.
  const conversation = await historyChat(
    config,
    phoneNumberId,
    customerPhone,
    scope
  );
  if (!conversation) return 'out_of_scope';
  const row = await historyRow(conversation.id, planned, accessToken);
  if (!row) return 'existed';
  const { error } = await supabaseAdmin().from('messages').insert(row);
  if (!error) return 'stored';
  if (isUniqueViolation(error)) return 'existed';
  throw new Error(error.message);
}

const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const;

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s);
  return idx < 0 ? -1 : idx;
}

function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') return current === 'pending' || current === 'sent';
  if (current === 'failed') return false;
  const ci = ladderLevel(current);
  const ii = ladderLevel(incoming);
  if (ii < 0) return false;
  if (ci < 0) return true;
  return ii > ci;
}

async function handleStatusUpdate(
  status: WhatsAppStatus,
  phoneNumberId: string
) {
  // SP3b billable counter. Never blocks status handling: a failed insert is
  // logged and the status update below still runs.
  const priced = pricingRow(status, phoneNumberId);
  if (priced) {
    try {
      const { error: pricingError } = await supabaseAdmin()
        .from('wa_message_pricing')
        .upsert(priced, { onConflict: 'message_id', ignoreDuplicates: true });
      if (pricingError) {
        console.error(
          '[webhook] failed to store pricing for',
          status.id,
          pricingError
        );
      }
    } catch (e) {
      console.error('[webhook] failed to store pricing for', status.id, e);
    }
  }

  const nextStatus = normalizeMessageStatus(status.status);

  // Meta explains a failure in errors[0] and nowhere else. Logged before the
  // write so the cause is visible even when the row is not eligible for the
  // update below (a late 'failed' after 'delivered', say).
  const failure = status.errors?.[0];
  if (failure) {
    console.warn(
      '[webhook] message %s failed: code=%s %s',
      status.id,
      failure.code,
      failure.error_data?.details ?? failure.title ?? ''
    );
  }

  if (nextStatus === null) {
    console.warn(
      '[webhook] ignoring unrecognised message status:',
      status.status
    );
  } else {
    const overwritable = statusesOverwritableBy(nextStatus);
    // Empty means nothing may advance to `nextStatus` (it is already at or past
    // it, or terminal), so there is no row to touch.
    if (overwritable.length > 0) {
      // One statement, so the reason lands atomically with the status it
      // explains. A second UPDATE would race with concurrent webhooks for the
      // same wamid, which is the reason the status predicate is inline too.
      const patch: {
        status: MessageStatus;
        error_code?: number;
        error_details?: string | null;
      } = { status: nextStatus };

      if (failure) {
        patch.error_code = failure.code;
        patch.error_details =
          failure.error_data?.details ?? failure.title ?? null;
      }

      const { error: msgErr } = await supabaseAdmin()
        .from('messages')
        .update(patch)
        .eq('message_id', status.id)
        .in('status', overwritable);

      if (msgErr) console.error('Error updating message status:', msgErr);
    }
  }

  const tsIso = new Date(parseInt(status.timestamp) * 1000).toISOString();
  const { data: recipient, error: recFetchErr } = await supabaseAdmin()
    .from('broadcast_recipients')
    .select('id, status')
    .eq('whatsapp_message_id', status.id)
    .maybeSingle();

  if (recFetchErr || !recipient) return;

  if (!isValidStatusTransition(recipient.status, status.status)) return;

  const update: Record<string, unknown> = { status: status.status };
  if (status.status === 'sent' && !('sent_at' in update))
    update.sent_at = tsIso;
  if (status.status === 'delivered') update.delivered_at = tsIso;
  if (status.status === 'read') update.read_at = tsIso;

  // Same reason as on `messages`, but this is the table where it matters most:
  // broadcasts send marketing templates, and the two failures that define them
  // are 131049 (per-user marketing cap) and 131050 (recipient opted out of
  // marketing). Both were previously recorded as a bare 'failed'. The column
  // already existed and was only ever written by the client-side send path.
  // Code is prefixed rather than given its own column because the existing
  // column is free text and this needs no migration.
  if (failure) {
    update.error_message =
      `${failure.code}: ${failure.error_data?.details ?? failure.title ?? ''}`.trim();
  }

  await supabaseAdmin()
    .from('broadcast_recipients')
    .update(update)
    .eq('id', recipient.id);
}

async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1);

    if (error || !recs || recs.length === 0) return;

    await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', recs[0].id);
  } catch (error) {
    console.error('[webhook] failed to mark broadcast reply:', error);
  }
}

async function lookupInternalIdByMetaId(
  metaId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', metaId)
    .eq('conversation_id', conversationId)
    .maybeSingle();
  if (error) {
    console.error('[webhook] failed to resolve reply target:', error);
  }
  return data?.id ?? null;
}

// On a lookup error this answers "no reply yet": a second greeting is a small
// cost next to a lead left in silence.
async function hasBotOrAgentReply(conversationId: string): Promise<boolean> {
  try {
    const { count, error } = await supabaseAdmin()
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conversationId)
      .in('sender_type', ['bot', 'agent']);
    if (error) throw error;
    return (count ?? 0) > 0;
  } catch (error) {
    console.error('[webhook] failed to check for an earlier reply:', error);
    return false;
  }
}

async function handleReaction(
  message: WhatsAppMessage,
  conversationId: string,
  contactId: string
) {
  const reaction = message.reaction;
  if (!reaction?.message_id) return;

  const targetInternalId = await lookupInternalIdByMetaId(
    reaction.message_id,
    conversationId
  );
  if (!targetInternalId) return;

  if (!reaction.emoji) {
    await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId);
    return;
  }

  await supabaseAdmin().from('message_reactions').upsert(
    {
      message_id: targetInternalId,
      conversation_id: conversationId,
      actor_type: 'customer',
      actor_id: contactId,
      emoji: reaction.emoji,
    },
    { onConflict: 'message_id,actor_type,actor_id' }
  );
}

async function processMessage(
  message: WhatsAppMessage,
  // Meta omits `profile` when the sender has no profile name set, and can
  // send an empty `contacts[]`, so neither the entry nor the profile is
  // guaranteed to be present.
  contact: { profile?: { name?: string }; wa_id: string } | undefined,
  accountId: string,
  configOwnerUserId: string,
  accessToken: string,
  phoneNumberId: string,
  // Per-account opt-out for the inbound media mirror (migration 051).
  mirrorSetting: boolean,
  // Counsellor number or not (migration 094).
  policy: NumberPolicy
) {
  const senderPhone = normalizePhone(message.from);
  const contactName = contact?.profile?.name ?? '';

  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    senderPhone,
    contactName,
    message.referral ? 'ads' : 'organic',
    policy.counsellorNumber
  );
  // Thrown, not returned: the message is not stored yet, so the webhook inbox
  // replays the delivery (the wamid guard makes the replay safe). A contact
  // left without its chat would otherwise stay chatless.
  if (!contactOutcome) throw new Error('contact not found or created');
  const contactRecord = contactOutcome.contact;

  const conversation = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id,
    phoneNumberId
  );
  if (!conversation) throw new Error('conversation not found or created');

  const actions = inboundActions(policy, {
    botActive: conversation.bot_active,
    mirrorSetting,
  });

  // Written from here rather than from the referral block in
  // parseMessageContent, which is a pure content parser with no conversation
  // in hand. This reuses the conversation already resolved above and only
  // fires on the first message of an ad-started thread, so it adds no round
  // trip to an ordinary inbound message.
  if (message.referral) {
    await persistAdReferral(
      conversation.id,
      message.referral,
      message.timestamp
    );

    // First-touch upgrade mirroring the n8n ad_headline semantics: a contact
    // who arrived organically and later clicks an ad becomes 'ads', but a
    // counsellor's manual attribution (reference/walkin) is never overwritten
    // — the .eq('source','organic') guard makes this a no-op otherwise.
    // Best-effort like persistAdReferral: log and continue.
    if (!contactOutcome.wasCreated) {
      const { error: sourceErr } = await supabaseAdmin()
        .from('contacts')
        .update({ source: 'ads', updated_at: new Date().toISOString() })
        .eq('id', contactRecord.id)
        .eq('source', 'organic');
      if (sourceErr) {
        console.warn(
          '[webhook] failed to upgrade contact source to ads:',
          sourceErr.message
        );
      }
    }
  }

  if (message.type === 'reaction') {
    await handleReaction(message, conversation.id, contactRecord.id);
    return;
  }

  // Types the content parser cannot read (unsupported, revoke, edit, button)
  // used to land as a blank customer message. See inbound-classification.ts.
  const special = classifyInboundMessage(message);
  if (special && !special.store) return;

  const { contentText, mediaUrl, mediaType, interactiveReplyId } = special
    ? {
        contentText: special.contentText,
        mediaUrl: null,
        mediaType: null,
        interactiveReplyId: special.interactiveReplyId,
      }
    : await parseMessageContent(
        message,
        accessToken,
        actions.mirrorMedia ? { accountId } : null
      );

  let replyToInternalId: string | null = null;
  if (message.context?.id) {
    replyToInternalId = await lookupInternalIdByMetaId(
      message.context.id,
      conversation.id
    );
  }

  const ALLOWED_CONTENT_TYPES = new Set([
    'text',
    'image',
    'document',
    'audio',
    'video',
    'location',
    'template',
    'interactive',
  ]);
  const contentType = ALLOWED_CONTENT_TYPES.has(message.type)
    ? message.type
    : message.type === 'sticker'
      ? 'image'
      : 'text';

  const messageTimestamp = Number.parseInt(message.timestamp, 10);
  const messageCreatedAt = Number.isFinite(messageTimestamp)
    ? new Date(messageTimestamp * 1000).toISOString()
    : new Date().toISOString();

  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer');
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0;

  const { error: msgError } = await supabaseAdmin()
    .from('messages')
    .insert({
      conversation_id: conversation.id,
      sender_type: 'customer',
      content_type: contentType,
      content_text: contentText,
      media_url: mediaUrl,
      // Meta told us the MIME type; recording it means a download does not
      // have to guess an extension from bytes it has not fetched yet
      // (migration 051).
      media_type: mediaType,
      message_id: message.id,
      status: 'delivered',
      created_at: messageCreatedAt,
      reply_to_message_id: replyToInternalId,
      interactive_reply_id: interactiveReplyId,
      error_code: special?.errorCode ?? null,
      error_details: special?.errorDetails ?? null,
    });

  if (msgError) {
    if (isUniqueViolation(msgError)) {
      // Meta retries webhooks. The WAMID uniqueness guard makes a retry a
      // successful no-op instead of duplicating the chat and automations.
      return;
    }
    console.error(
      '[webhook] failed to insert inbound message for conversation',
      conversation.id,
      msgError
    );
    return;
  }

  // Preview/timestamp are derived by the message trigger. This RPC only
  // performs the stateful pieces atomically so concurrent messages cannot
  // lose an unread increment, and a reply to an archived chat reopens it.
  const { error: conversationError } = await supabaseAdmin().rpc(
    'mark_conversation_inbound',
    { p_conversation_id: conversation.id }
  );
  if (conversationError) {
    console.error(
      '[webhook] failed to mark conversation inbound',
      conversation.id,
      conversationError
    );
  }

  // SP3b: a lead messaged their counsellor's own number (counsellor numbers
  // come from counsellors.phone_number_id since 094; the env list still
  // counts). Runs on every inbound there, not only the first:
  // mark_counsellor_reached is idempotent, and a first message whose RPC
  // failed (or whose webhook retry hit the duplicate guard) is caught by the
  // next one. History never marks reached (see processHistoryChange).
  if (actions.markArrival) {
    await markCounsellorArrival(contactRecord.id, phoneNumberId);
  }

  await flagBroadcastReplyIfAny(accountId, contactRecord.id);

  // ===== FIRE AND FORGET TO n8n =====
  // Per-conversation AI toggle (KB-BOTTOGGLE-R4-15). `bot_active` defaults to
  // true, so existing and new threads keep replying exactly as before; the
  // inbox switch sets it false to silence the bot on a personal chat.
  // Gating the forward is what disables the reply: this is the only n8n call
  // site, and the workflow it triggers exists solely to produce the AI answer.
  // Inbound is still stored, tagged and shown in the inbox as normal.
  //
  // AI_DISABLED_PHONE_NUMBER_IDS silences a whole business number the same way,
  // for when a number is being wound down or handed to humans. Comma-separated
  // phone_number_ids; unset means nothing is silenced. It is checked here rather
  // than per conversation so new threads on that number are covered too.
  // A counsellor number (counsellors.phone_number_id, migration 094) is always
  // silenced, with no .env entry: see number-policy.ts.
  // An unreadable message (Meta 131051/131060) as the first inbound of a chat
  // nobody has answered is a lead's first contact. The bot is handed a plain
  // greeting as a text message (n8n drops any other type) so they get the
  // opening question. Requiring the first inbound keeps a burst of two
  // unreadable messages from being greeted twice before the reply is stored.
  const pastFirstContact = special?.greetWhenFirst
    ? !isFirstInboundMessage || (await hasBotOrAgentReply(conversation.id))
    : false;
  const botForward = botForwardFor(special, pastFirstContact);

  if (!actions.forwardToBot) {
    console.log(
      '[webhook] AI replies disabled, skipping n8n forward for conversation',
      conversation.id
    );
  } else if (!botForward.forward) {
    // A label or an edit is not something a customer asked; the bot would
    // only answer our own placeholder text.
    console.log(
      `[webhook] ${message.type} message, skipping n8n forward for conversation`,
      conversation.id
    );
  } else {
    if (botForward.greet) {
      console.log(
        `[webhook] ${message.type} first contact, greeting via n8n for conversation`,
        conversation.id
      );
    }
    forwardToN8n('message.received', {
      raw_webhook: {
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    botForward.greet
                      ? {
                          ...message,
                          type: 'text',
                          text: { body: FIRST_CONTACT_GREETING },
                        }
                      : {
                          ...message,
                          text: {
                            body: contentText ?? message.text?.body ?? '',
                          },
                        },
                  ],
                  contacts: [contact],
                  metadata: { phone_number_id: phoneNumberId },
                },
              },
            ],
          },
        ],
      },
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
      account_id: accountId,
      // access_token was forwarded here for years and consumed by NOTHING -
      // zero references in any workflow node (verified against the live
      // export). Its only effect was to write a plaintext copy of the
      // WhatsApp token into n8n's execution_data on every single message.
      // n8n's own sends use its credential store. Do not add it back.
    }).catch((err) => console.error('[n8n forward] error:', err));
  }
  // ===================================

  // Flows and automations send through the API from this chat's number: never
  // on a counsellor's own number, which only the counsellor's app speaks from.
  if (!actions.runAutomations) return;

  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    // A template button reply carries a payload, not a flow node's reply id,
    // so flows see it as the text the customer tapped.
    message:
      interactiveReplyId && !special
        ? {
            kind: 'interactive_reply',
            reply_id: interactiveReplyId,
            reply_title: contentText ?? '',
            meta_message_id: message.id,
          }
        : {
            kind: 'text',
            text: special
              ? special.automationText
              : (contentText ?? message.text?.body ?? ''),
            meta_message_id: message.id,
          },
    isFirstInboundMessage,
  });

  const inboundText = special
    ? special.automationText
    : (contentText ?? message.text?.body ?? '');
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
  )[] = [];
  if (!flowResult.consumed)
    automationTriggers.push('new_message_received', 'keyword_match');
  if (contactOutcome.wasCreated)
    automationTriggers.unshift('new_contact_created');
  if (isFirstInboundMessage)
    automationTriggers.unshift('first_inbound_message');

  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: { message_text: inboundText, conversation_id: conversation.id },
    }).catch(() => {});
  }
}

async function parseMessageContent(
  message: WhatsAppMessage,
  accessToken: string,
  // Tenancy + opt-out for the media mirror (migration 051). Null
  // disables mirroring. Both the inbound and the echo path pass a
  // value: an echo is an agent's send from the WhatsApp Business app,
  // which Meta hosts and expires exactly like inbound media. Only the
  // composer's own sends are already durable, and those never reach
  // this function.
  mirror: { accountId: string; folder?: string } | null = null
) {
  const verifyAndBuildUrl = async (media: {
    id: string;
    mime_type?: string;
    filename?: string;
    file_size?: number;
  }): Promise<string | null> => {
    try {
      // Called for its side effect of proving the id is fetchable; the
      // CDN url it returns is short-lived, which is exactly why the
      // stored value has to be either a mirror or the proxy pointer.
      const { url: downloadUrl } = await getMediaUrl({
        mediaId: media.id,
        accessToken,
      });

      // Copy the bytes into chat-media so they outlive Meta's ~30-day
      // retention. Best effort by design: on any failure this returns
      // null and we keep the proxy pointer, which still works for as
      // long as Meta holds the media.
      if (mirror) {
        const mirrored = await mirrorInboundMedia({
          storage: supabaseAdmin().storage,
          accountId: mirror.accountId,
          mediaId: media.id,
          downloadUrl,
          accessToken,
          mimeType: media.mime_type,
          fileSize: media.file_size,
          fileName: media.filename,
          messageTimestamp: message.timestamp,
          folder: mirror.folder,
        });
        if (mirrored) return mirrored;
      }

      return `/api/whatsapp/media/${media.id}`;
    } catch (err) {
      console.error('[webhook] media verification failed:', media.id, err);
      return null;
    }
  };

  const empty = {
    contentText: null as string | null,
    mediaUrl: null as string | null,
    mediaType: null as string | null,
    interactiveReplyId: null as string | null,
  };

  switch (message.type) {
    case 'text':
      empty.contentText = message.text?.body || null;
      break;
    case 'image':
      empty.contentText = message.image?.caption || null;
      if (message.image?.id) {
        empty.mediaUrl = await verifyAndBuildUrl(message.image);
        empty.mediaType = message.image.mime_type;
      }
      break;
    case 'video':
      empty.contentText = message.video?.caption || null;
      if (message.video?.id) {
        empty.mediaUrl = await verifyAndBuildUrl(message.video);
        empty.mediaType = message.video.mime_type;
      }
      break;
    case 'document':
      empty.contentText =
        message.document?.caption || message.document?.filename || null;
      if (message.document?.id) {
        empty.mediaUrl = await verifyAndBuildUrl(message.document);
        empty.mediaType = message.document.mime_type;
      }
      break;
    case 'audio':
      if (message.audio?.id) {
        empty.mediaUrl = await verifyAndBuildUrl(message.audio);
        empty.mediaType = message.audio.mime_type;
      }
      break;
    case 'location':
      if (message.location) {
        empty.contentText = [
          message.location.name,
          message.location.address,
          `${message.location.latitude},${message.location.longitude}`,
        ]
          .filter(Boolean)
          .join(' - ');
      }
      break;
    case 'interactive': {
      const reply =
        message.interactive?.button_reply ?? message.interactive?.list_reply;
      if (reply?.id) {
        empty.contentText = reply.title || reply.id;
        empty.interactiveReplyId = reply.id;
      } else {
        empty.contentText = '[Interactive reply]';
      }
      break;
    }
    default:
      empty.contentText = message.text?.body || null;
      break;
  }

  // >>> INJECT THE FACEBOOK AD CONTEXT <<<
  if (message.referral) {
    // TEMPORARY (added 2026-08-20, Skeure Growth phase 1.1): log the referral
    // object verbatim to find out which fields Meta actually sends on this WABA.
    // The interface above declares only headline/body/source_url, but TypeScript
    // types are erased at runtime, so anything else Meta sends is still present
    // on this object -- specifically `ctwa_clid` and `source_id`, which are what
    // tie a WhatsApp lead back to the ad that paid for it. Right now they are
    // read, used to build a display banner, and dropped.
    // Contains ad metadata only, no message body and no phone number, so this is
    // safe to log. Remove once the fields are confirmed and persisted properly.
    console.log(
      '[webhook] ctwa-probe referral keys:',
      Object.keys(message.referral),
      JSON.stringify(message.referral)
    );

    const headline = message.referral.headline
      ? `🚀 *Ad Clicked:* ${message.referral.headline}`
      : '';
    const body = message.referral.body ? `\n${message.referral.body}` : '';
    const url = message.referral.source_url
      ? `\n🔗 ${message.referral.source_url}`
      : '';
    const adBanner = `${headline}${body}${url}\n\n`;

    // Attach the Ad to the very top of their message!
    empty.contentText = empty.contentText
      ? adBanner + empty.contentText
      : adBanner;
  }

  return empty;
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string,
  // Stored lead channel (migration 073): 'ads' when the first inbound
  // message carries a CTWA referral, else 'organic'. Only these two are
  // ever webhook-derived; reference/walkin are counsellor-entered.
  source: 'organic' | 'ads' = 'organic',
  // First seen on a counsellor number (094): made through
  // create_counsellor_number_contact, so it gets no LD lead number and stays
  // admin and owner only until it has a chat on another number.
  onCounsellorNumber = false
) {
  const existingContact = await findExistingContact(
    supabaseAdmin(),
    accountId,
    phone
  );

  if (existingContact) {
    if (name && name !== existingContact.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id);
    }
    return { contact: existingContact, wasCreated: false };
  }

  const { data: created, error: createError } = onCounsellorNumber
    ? await supabaseAdmin().rpc('create_counsellor_number_contact', {
        p_account_id: accountId,
        p_user_id: configOwnerUserId,
        p_phone: phone,
        p_name: name,
        p_source: source,
      })
    : await supabaseAdmin()
        .from('contacts')
        .insert({
          account_id: accountId,
          user_id: configOwnerUserId,
          phone,
          name: name || phone,
          source,
        })
        .select()
        .single();
  // The RPC returns a set (one row).
  const newContact = Array.isArray(created) ? created[0] : created;

  if (createError) {
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(
        supabaseAdmin(),
        accountId,
        phone
      );
      if (raced) return { contact: raced, wasCreated: false };
    }
    console.error(
      '[webhook] failed to create contact for phone',
      maskPhone(phone),
      errorText(createError)
    );
    return null;
  }
  if (!newContact) {
    console.error(
      '[webhook] contact insert returned no row for phone',
      maskPhone(phone)
    );
    return null;
  }

  return { contact: newContact, wasCreated: true };
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
  phoneNumberId: string
) {
  // Threads are keyed by (account, contact, business number) since migration
  // 037. A lead who also writes to another of the account's numbers gets a
  // separate thread there rather than re-tagging this one, so each number keeps
  // its own conversation and replies always leave from the number that thread
  // belongs to.
  const { data: existing, error: lookupError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('phone_number_id', phoneNumberId)
    .maybeSingle();

  if (lookupError) {
    console.error(
      '[webhook] failed to find conversation for contact',
      contactId,
      lookupError
    );
    return null;
  }

  if (existing) return existing;

  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
      phone_number_id: phoneNumberId,
    })
    .select()
    .single();

  if (createError) {
    if (isUniqueViolation(createError)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .eq('phone_number_id', phoneNumberId)
        .maybeSingle();
      if (raced) return raced;
    }
    console.error(
      '[webhook] failed to create conversation for contact',
      contactId,
      createError
    );
    return null;
  }

  return newConv;
}

/**
 * Store the click-to-WhatsApp ad context on the conversation (migration 061).
 *
 * Meta attaches `referral` to the first inbound message of an ad-started
 * conversation and to no later one, so this is the only chance to keep
 * `ctwa_clid` and the ad id. Those two are what connects an admission back to
 * the ad that paid for it; before this the referral was read only to build the
 * display banner in parseMessageContent and the identifiers were dropped.
 *
 * Last touch wins, by design. A contact who clicks a second ad has genuinely
 * re-entered from that ad, so the new referral overwrites the old one. Absent
 * fields are written as NULL rather than left alone for the same reason: the
 * row describes one referral event, and keeping ad A's headline next to ad B's
 * click id would misattribute the conversion.
 *
 * A failure here is logged and swallowed. Attribution is valuable but it is not
 * worth dropping the customer's message over.
 */
async function persistAdReferral(
  conversationId: string,
  referral: NonNullable<WhatsAppMessage['referral']>,
  messageTimestamp: string
) {
  // Meta's own stamp on the message carrying the referral - the only temporal
  // handle on the click. ad_referral_at (receipt wall-clock) stays for audit,
  // but LAST TOUCH is decided by this value: Meta retries deliveries with no
  // ordering guarantee, so a delayed retry of ad A landing after ad B used to
  // overwrite B and stamp a LATER receipt time, making the record assert A was
  // newest. A conversion then reports against the wrong ad, which trains the
  // optimiser toward the wrong creative - worse than not reporting at all.
  const ts = Number.parseInt(messageTimestamp, 10);
  const msgAt = Number.isFinite(ts)
    ? new Date(ts * 1000).toISOString()
    : new Date().toISOString();

  const { error } = await supabaseAdmin()
    .from('conversations')
    .update({
      ctwa_clid: referral.ctwa_clid ?? null,
      ad_source_id: referral.source_id ?? null,
      ad_source_type: referral.source_type ?? null,
      ad_headline: referral.headline ?? null,
      ad_source_url: referral.source_url ?? null,
      ad_referral_at: new Date().toISOString(),
      ad_referral_msg_at: msgAt,
    })
    .eq('id', conversationId)
    // The guard: only a NEWER click wins. An out-of-order replay of an older
    // referral matches zero rows instead of clobbering the current one.
    .or(`ad_referral_msg_at.is.null,ad_referral_msg_at.lt.${msgAt}`);

  if (error) {
    console.error(
      '[webhook] failed to store ad referral for conversation',
      conversationId,
      error
    );
  }
}
