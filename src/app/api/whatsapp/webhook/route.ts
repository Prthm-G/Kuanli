import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createHmac } from 'node:crypto';
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption';
import { getMediaUrl } from '@/lib/whatsapp/meta-api';
import { mirrorInboundMedia } from '@/lib/whatsapp/mirror-inbound-media';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
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

interface WhatsAppMessage {
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
      statuses?: Array<{
        id: string;
        status: string;
        timestamp: string;
        recipient_id: string;
      }>;
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

  processWebhook(body).catch((error) => {
    console.error('Error processing webhook:', error);
  });

  return NextResponse.json({ status: 'received' }, { status: 200 });
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

      const value = change.value;

      if (value.statuses) {
        for (const status of value.statuses) {
          await handleStatusUpdate(status);
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
          config.mirror_inbound_media !== false
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
  await backfillDisplayPhoneNumber(config, value.metadata.display_phone_number);
  const decryptedAccessToken = decrypt(config.access_token);

  // Isolated per item: one malformed/unexpected echo must not abort the
  // rest of this delivery's other changes (the route already returned its
  // 200 to Meta before processWebhook finishes running).
  for (const echo of items) {
    try {
      await processEchoItem(
        echo,
        config.account_id,
        config.user_id,
        decryptedAccessToken,
        phoneNumberId,
        config.mirror_inbound_media !== false
      );
    } catch (err) {
      console.error(
        '[webhook] failed to process smb_message_echoes item',
        echo.id,
        err
      );
    }
  }
}

async function processEchoItem(
  echo: WhatsAppMessageEcho,
  accountId: string,
  configOwnerUserId: string,
  accessToken: string,
  phoneNumberId: string,
  // Per-account opt-out for the media mirror (migration 051).
  mirrorMedia: boolean
) {
  // No contacts[]/profile name on this field — resolve by phone alone.
  const customerPhone = normalizePhone(echo.to);

  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    customerPhone,
    ''
  );
  if (!contactOutcome) return;
  const contactRecord = contactOutcome.contact;

  const conversation = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id,
    phoneNumberId
  );
  if (!conversation) return;

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

async function handleStatusUpdate(status: {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
}) {
  const nextStatus = normalizeMessageStatus(status.status);
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
      const { error: msgErr } = await supabaseAdmin()
        .from('messages')
        .update({ status: nextStatus })
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
  mirrorMedia: boolean
) {
  const senderPhone = normalizePhone(message.from);
  const contactName = contact?.profile?.name ?? '';

  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    senderPhone,
    contactName,
    message.referral ? 'ads' : 'organic'
  );
  if (!contactOutcome) return;
  const contactRecord = contactOutcome.contact;

  const conversation = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id,
    phoneNumberId
  );
  if (!conversation) return;

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

  const { contentText, mediaUrl, mediaType, interactiveReplyId } =
    await parseMessageContent(
      message,
      accessToken,
      mirrorMedia ? { accountId } : null
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

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
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

  await flagBroadcastReplyIfAny(accountId, contactRecord.id);

  // ===== FIRE AND FORGET TO n8n =====
  // Per-conversation AI toggle (KB-BOTTOGGLE-R4-15). `bot_active` defaults to
  // true, so existing and new threads keep replying exactly as before; the
  // inbox switch sets it false to silence the bot on a personal chat.
  // Gating the forward is what disables the reply: this is the only n8n call
  // site, and the workflow it triggers exists solely to produce the AI answer.
  // Inbound is still stored, tagged and shown in the inbox as normal.
  if (conversation.bot_active === false) {
    console.log(
      '[webhook] AI replies disabled, skipping n8n forward for conversation',
      conversation.id
    );
  } else {
    forwardToN8n('message.received', {
      raw_webhook: {
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      ...message,
                      text: { body: contentText ?? message.text?.body ?? '' },
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

  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message: interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: interactiveReplyId,
          reply_title: contentText ?? '',
          meta_message_id: message.id,
        }
      : {
          kind: 'text',
          text: contentText ?? message.text?.body ?? '',
          meta_message_id: message.id,
        },
    isFirstInboundMessage,
  });

  const inboundText = contentText ?? message.text?.body ?? '';
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
  source: 'organic' | 'ads' = 'organic'
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

  const { data: newContact, error: createError } = await supabaseAdmin()
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
      phone,
      createError
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
