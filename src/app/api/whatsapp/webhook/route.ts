import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createHmac } from 'node:crypto';
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption';
import { getMediaUrl } from '@/lib/whatsapp/meta-api';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook';

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
  image?: { id: string; mime_type: string; caption?: string };
  video?: { id: string; mime_type: string; caption?: string };
  document?: {
    id: string;
    mime_type: string;
    filename?: string;
    caption?: string;
  };
  audio?: { id: string; mime_type: string };
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
  referral?: { headline?: string; body?: string; source_url?: string };
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
          phoneNumberId
        );
      }
    }
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
  const { error: msgErr } = await supabaseAdmin()
    .from('messages')
    .update({ status: status.status })
    .eq('message_id', status.id);

  if (msgErr) console.error('Error updating message status:', msgErr);

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
  contact: { profile: { name: string }; wa_id: string },
  accountId: string,
  configOwnerUserId: string,
  accessToken: string,
  phoneNumberId: string
) {
  const senderPhone = normalizePhone(message.from);
  const contactName = contact.profile.name;

  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    senderPhone,
    contactName
  );
  if (!contactOutcome) return;
  const contactRecord = contactOutcome.contact;

  const conversation = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id
  );
  if (!conversation) return;

  if (message.type === 'reaction') {
    await handleReaction(message, conversation.id, contactRecord.id);
    return;
  }

  const { contentText, mediaUrl, mediaType, interactiveReplyId } =
    await parseMessageContent(message, accessToken);

  let replyToInternalId: string | null = null;
  if (message.context?.id) {
    replyToInternalId = await lookupInternalIdByMetaId(
      message.context.id,
      conversation.id
    );
  }

  void mediaType;

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
  }).catch((err) => console.error('[n8n forward] error:', err));
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
  accessToken: string
) {
  const verifyAndBuildUrl = async (mediaId: string): Promise<string | null> => {
    try {
      await getMediaUrl({ mediaId, accessToken });
      return `/api/whatsapp/media/${mediaId}`;
    } catch (err) {
      console.error('[webhook] media verification failed:', mediaId, err);
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
        empty.mediaUrl = await verifyAndBuildUrl(message.image.id);
        empty.mediaType = message.image.mime_type;
      }
      break;
    case 'video':
      empty.contentText = message.video?.caption || null;
      if (message.video?.id) {
        empty.mediaUrl = await verifyAndBuildUrl(message.video.id);
        empty.mediaType = message.video.mime_type;
      }
      break;
    case 'document':
      empty.contentText =
        message.document?.caption || message.document?.filename || null;
      if (message.document?.id) {
        empty.mediaUrl = await verifyAndBuildUrl(message.document.id);
        empty.mediaType = message.document.mime_type;
      }
      break;
    case 'audio':
      if (message.audio?.id) {
        empty.mediaUrl = await verifyAndBuildUrl(message.audio.id);
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
  name: string
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
  contactId: string
) {
  const { data: existing, error: lookupError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
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
