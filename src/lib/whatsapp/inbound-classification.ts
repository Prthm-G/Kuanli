/**
 * Inbound message types the webhook's content parser does not read.
 *
 * The parser in webhook/route.ts handles text, media, location, interactive and
 * reactions. Everything else used to fall through to its default branch and was
 * stored as a customer `text` message with a NULL body. Meta sends several such
 * types, and each one left a blank "message" in the inbox:
 *
 *   unsupported  Meta could not hand us the content. 131060 ("currently
 *                unavailable") fires when someone first messages a coexistence
 *                number, and the content often never arrives anywhere, not even
 *                in the WhatsApp Business app. 131051 is a type Cloud API does
 *                not support (polls, group invites, ...).
 *   revoke       The customer deleted an earlier message.
 *   edit         The customer edited an earlier message; the new content is
 *                nested under `edit.message`.
 *   button       A tap on a template quick-reply button.
 *
 * Verified against the developers.facebook.com messages webhook reference
 * (unsupported, revoke, edit, button) on 2026-10-01.
 *
 * Returns null for types the content parser already handles, so the caller
 * keeps its existing path for them.
 */

export interface ClassifiableInboundMessage {
  type: string;
  errors?: {
    code?: number;
    title?: string;
    message?: string;
    error_data?: { details?: string };
  }[];
  unsupported?: { type?: string };
  revoke?: { original_message_id?: string };
  edit?: {
    original_message_id?: string;
    message?: {
      type?: string;
      text?: { body?: string };
      image?: { caption?: string };
      video?: { caption?: string };
      document?: { caption?: string };
    };
  };
  button?: { text?: string; payload?: string };
}

export interface InboundClassification {
  /** false: record nothing for this event. */
  store: boolean;
  contentText: string | null;
  interactiveReplyId: string | null;
  errorCode: number | null;
  errorDetails: string | null;
  /** Whether the AI bot (n8n) should answer this message. */
  forwardToBot: boolean;
  /** Text handed to flows and automations. Empty for non-content events, as before. */
  automationText: string;
}

/** Written by migration 077 over the blanks stored before this classifier existed. */
export const BACKFILL_LABEL =
  'Message content not available in Kuanli (unsupported, edited or deleted on WhatsApp). Check the WhatsApp Business app.';

const PARSED_TYPES = new Set([
  'text',
  'image',
  'video',
  'document',
  'audio',
  'sticker',
  'location',
  'interactive',
  'reaction',
]);

function label(contentText: string): InboundClassification {
  return {
    store: true,
    contentText,
    interactiveReplyId: null,
    errorCode: null,
    errorDetails: null,
    forwardToBot: false,
    automationText: '',
  };
}

export function classifyInboundMessage(
  message: ClassifiableInboundMessage
): InboundClassification | null {
  if (PARSED_TYPES.has(message.type)) return null;

  switch (message.type) {
    case 'unsupported': {
      const error = message.errors?.[0];
      const code = typeof error?.code === 'number' ? error.code : null;
      const text =
        code === 131060
          ? 'Message unavailable (Meta 131060). They tried to reach us; follow up from the WhatsApp Business app.'
          : code !== null
            ? `Unsupported message type (Meta ${code}). Check the WhatsApp Business app.`
            : 'Unsupported message type. Check the WhatsApp Business app.';
      return {
        ...label(text),
        errorCode: code,
        errorDetails:
          error?.error_data?.details ?? error?.title ?? error?.message ?? null,
      };
    }

    case 'revoke':
      return { ...label(''), store: false, contentText: null };

    case 'edit': {
      const edited = message.edit?.message;
      const body =
        edited?.text?.body ??
        edited?.image?.caption ??
        edited?.video?.caption ??
        edited?.document?.caption;
      return label(body ? `(edited) ${body}` : '(edited message)');
    }

    case 'button': {
      const text = message.button?.text ?? '';
      return {
        ...label(text),
        interactiveReplyId: message.button?.payload ?? null,
        forwardToBot: true,
        automationText: text,
      };
    }

    default:
      return label(
        `Unsupported message type (${message.type}). Check the WhatsApp Business app.`
      );
  }
}
