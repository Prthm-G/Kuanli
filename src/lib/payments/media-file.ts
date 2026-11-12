/**
 * Fetch a chat image as a `File`, so "Log payment" on a WhatsApp message can
 * preset it as the receipt. `message.media_url` is either the authenticated
 * proxy (`/api/whatsapp/media/<id>`, same-origin so the session cookie goes
 * along) or a mirrored chat-media URL; a plain `fetch` handles both, the same
 * way the message bubble loads the image.
 */
const EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export async function fetchMediaAsFile(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<File> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error('Could not load the image');

  const blob = await res.blob();
  const type = blob.type.split(';')[0].trim();
  const ext = EXTENSION[type];
  if (!ext) throw new Error('That message is not an image we can attach');

  return new File([blob], `chat-image.${ext}`, { type });
}
