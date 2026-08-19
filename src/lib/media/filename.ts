// ============================================================
// MIME → file extension.
//
// Used when mirroring inbound WhatsApp media into the chat-media
// bucket: Meta hands us a MIME type, and the stored object needs a
// sensible extension so an agent who downloads it gets a file their
// OS can open.
//
// Ported from upstream ArnasDon/wacrm `src/lib/media/filename.ts`,
// trimmed to the map and lookup — upstream's download-name helpers
// belong to its inbox attachment-download feature, which this fork
// has not ported.
//
// The map covers what Meta realistically delivers. Anything unknown
// falls back to `bin` rather than guessing, which keeps a
// sender-controlled MIME from choosing an executable extension.
// ============================================================

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/quicktime': 'mov',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    'pptx',
  'text/plain': 'txt',
};

/**
 * File extension for a MIME type, without the leading dot. Parameters
 * are ignored, so `audio/ogg; codecs=opus` — what Meta actually sends
 * for a voice note — resolves as `audio/ogg`.
 */
export function extensionForMime(mimeType?: string | null): string {
  if (!mimeType) return 'bin';
  const base = mimeType.split(';')[0].trim().toLowerCase();
  return EXTENSION_BY_MIME[base] ?? 'bin';
}
