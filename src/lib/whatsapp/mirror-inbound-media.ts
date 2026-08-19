import { downloadMedia } from './meta-api';
import { extensionForMime } from '@/lib/media/filename';
import { buildMediaPath, MEDIA_MAX_BYTES } from '@/lib/storage/upload-media';

/**
 * Copies inbound WhatsApp media into the `chat-media` bucket so it
 * outlives Meta's retention window.
 *
 * Meta deletes media roughly 30 days after receipt. Before this, the
 * webhook stored only a pointer — `/api/whatsapp/media/<mediaId>` — and
 * the proxy route behind it re-fetched from Meta on every view, so an
 * attachment quietly became unviewable a month after it arrived.
 * Outbound media never had the problem: the composer uploads to
 * `chat-media` (migration 023) and stores a durable public URL. This
 * puts inbound on the same footing.
 *
 * Note this is broader than migration 045's document archive. That one
 * only rescues application documents an agent has explicitly verified;
 * everything else — photos, voice notes, documents nobody got to yet —
 * still points at Meta. This covers those.
 *
 * Everything here is BEST EFFORT and returns `null` rather than
 * throwing. The caller is the Meta webhook, and a webhook that starts
 * failing is worse than an attachment that expires: Meta retries the
 * delivery, which re-runs contact creation, flows, automations and the
 * n8n forward. On any failure — oversized file, MIME the bucket
 * refuses, storage outage — the caller keeps the proxy URL, which still
 * works for as long as Meta holds the bytes.
 *
 * Ported from upstream ArnasDon/wacrm `mirror-inbound-media.ts`
 * (issue #466), adapted to this fork's `buildMediaPath` and size limits.
 */

/** Service-role Storage surface this needs. Narrow so tests can fake it. */
export interface MirrorStorage {
  from(bucket: string): {
    upload(
      path: string,
      body: Uint8Array | Buffer,
      options: { contentType: string; cacheControl: string; upsert: boolean }
    ): Promise<{ error: { message: string } | null }>;
    getPublicUrl(path: string): { data: { publicUrl: string } };
  };
}

/** Bucket the composer already writes to; inbound joins it. */
export const MIRROR_BUCKET = 'chat-media';

/**
 * Second path segment for mirrored inbound objects, so a bucket listing
 * separates "things a customer sent us" from "things we sent". The
 * chat-media policies match on `foldername(name)[1]` — the
 * `account-<id>` segment — so an extra level costs nothing in access
 * control.
 */
export const MIRROR_FOLDER = 'inbound';

export interface MirrorInboundMediaArgs {
  /** Service-role `supabase.storage` — RLS is bypassed, MIME/size limits are not. */
  storage: MirrorStorage;
  /** Tenant. Drives the account-scoped path the bucket's policies expect. */
  accountId: string;
  /** Meta's media id. Makes the object path deterministic. */
  mediaId: string;
  /** Short-lived CDN URL from `getMediaUrl`. */
  downloadUrl: string;
  accessToken: string;
  /** Meta's `mime_type` for the media. */
  mimeType?: string | null;
  /** Meta's `file_size`, when it gave us one — lets us skip before downloading. */
  fileSize?: number | null;
  /** `document.filename`, when the sender's client supplied one. */
  fileName?: string | null;
  /** Meta's message timestamp (epoch SECONDS) — keeps object names distinct. */
  messageTimestamp?: string | number | null;
  /** Injected in tests. */
  download?: typeof downloadMedia;
}

/**
 * Lower-case a MIME type and drop its parameters, so `audio/ogg;
 * codecs=opus` — which is what Meta actually sends for a voice note —
 * is matched against the bucket's allow-list as plain `audio/ogg`.
 * Returns null for anything unusable.
 */
export function normalizeMimeType(value?: string | null): string | null {
  if (!value) return null;
  const base = value.split(';')[0].trim().toLowerCase();
  return base.includes('/') ? base : null;
}

/**
 * Coarse noun for a MIME type, used to build a readable object name.
 * Deliberately matches the `content_type` vocabulary in the UI rather
 * than the MIME top-level (`application/*` reads as "document").
 */
function kindForMime(mimeType: string | null): string {
  if (!mimeType) return 'file';
  const [top] = mimeType.split('/');
  if (top === 'image' || top === 'video' || top === 'audio') return top;
  if (top === 'text' || top === 'application') return 'document';
  return 'file';
}

/**
 * The object's filename inside the account folder. Pure, so the naming
 * rules can be tested without a Storage client.
 *
 * Prefixed with the media id, which makes the whole path deterministic:
 * a Meta redelivery of the same message rewrites the same object rather
 * than littering the bucket with a second copy.
 *
 * Names are kept short on purpose: `buildMediaPath` caps the basename
 * it receives at 40 characters, and a long media id plus a separator
 * already spends much of that.
 */
export function mirrorFileName(args: {
  mediaId: string;
  mimeType: string | null;
  fileName?: string | null;
  messageTimestamp?: string | number | null;
}): string {
  const { mediaId, mimeType, fileName, messageTimestamp } = args;
  const ext = extensionForMime(mimeType);

  // A document's own name is the best name there is, so keep it. Strip
  // any directory part and its extension — the extension is re-derived
  // from the MIME type rather than from a sender-controlled string.
  const stem = (fileName ?? '')
    .split(/[\\/]/)
    .pop()!
    .replace(/\.[^.]+$/, '')
    .trim();
  if (stem) return `${mediaId}-${stem}.${ext}`;

  // Otherwise synthesise. Meta's message timestamp goes in the name so
  // two photos from one thread don't collide — and it's Meta's stamp,
  // not the clock, so the path stays stable across a redelivery.
  const kind = kindForMime(mimeType);
  const stamp = String(messageTimestamp ?? '').replace(/\D/g, '');
  return `${mediaId}-${stamp ? `${kind}-${stamp}` : kind}.${ext}`;
}

/**
 * Download the bytes from Meta and put them in `chat-media`.
 *
 * @returns the durable public URL, or `null` if the mirror was skipped
 *          or failed — in which case the caller must fall back to the
 *          proxy URL.
 */
export async function mirrorInboundMedia(
  args: MirrorInboundMediaArgs
): Promise<string | null> {
  const {
    storage,
    accountId,
    mediaId,
    downloadUrl,
    accessToken,
    mimeType,
    fileSize,
    fileName,
    messageTimestamp,
    download = downloadMedia,
  } = args;

  const normalizedMime = normalizeMimeType(mimeType);

  // Skip oversized media BEFORE spending the transfer. Meta allows
  // documents up to 100 MB and the bytes are buffered in memory inside
  // a webhook handler, so this is a real case rather than a defensive
  // one.
  if (typeof fileSize === 'number' && fileSize > MEDIA_MAX_BYTES) {
    console.warn(
      `[mirror-media] skipping ${mediaId}: ${fileSize} bytes exceeds the ${MEDIA_MAX_BYTES}-byte ceiling`
    );
    return null;
  }

  try {
    const { buffer, contentType } = await download({
      downloadUrl,
      accessToken,
    });

    // Meta's `file_size` is advisory; the transfer is the truth. Check
    // again so an understated size can't push an oversized object into
    // the bucket.
    if (buffer.byteLength > MEDIA_MAX_BYTES) {
      console.warn(
        `[mirror-media] skipping ${mediaId}: downloaded ${buffer.byteLength} bytes, over the ${MEDIA_MAX_BYTES}-byte ceiling`
      );
      return null;
    }

    // Meta's metadata MIME wins over the CDN response header: it's what
    // the message row records, so mirroring it keeps `media_type` and
    // the stored object describing the same thing.
    const uploadType =
      normalizedMime ??
      normalizeMimeType(contentType) ??
      'application/octet-stream';

    const objectName = mirrorFileName({
      mediaId,
      mimeType: uploadType,
      fileName,
      messageTimestamp,
    });
    // `null` suppresses buildMediaPath's wall-clock stamp: the media id
    // already makes this path unique AND stable, and it's the stability
    // that makes a redelivery idempotent rather than duplicative.
    const path = buildMediaPath(accountId, objectName, null, MIRROR_FOLDER);

    // `upsert: true` for that same reason: on the rare Meta redelivery
    // the second pass rewrites byte-identical content at the same key
    // instead of erroring or orphaning a duplicate.
    const { error } = await storage.from(MIRROR_BUCKET).upload(path, buffer, {
      contentType: uploadType,
      cacheControl: '3600',
      upsert: true,
    });
    if (error) {
      // Most likely a MIME outside the bucket's allow-list. Log and let
      // the caller keep the proxy URL.
      console.warn(
        `[mirror-media] upload failed for ${mediaId} (${uploadType}):`,
        error.message
      );
      return null;
    }

    const {
      data: { publicUrl },
    } = storage.from(MIRROR_BUCKET).getPublicUrl(path);
    return publicUrl || null;
  } catch (error) {
    console.warn(
      `[mirror-media] could not mirror ${mediaId}:`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}
