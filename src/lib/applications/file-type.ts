export type DetectedFileType = 'pdf' | 'jpeg' | 'png' | 'webp';

const startsWith = (b: Uint8Array, sig: number[], at = 0) =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

/**
 * The type of an uploaded file from its first bytes. The file name and the
 * browser's content type are never trusted: a script renamed to `.pdf` has the
 * wrong bytes and comes back null.
 */
export function detectFileType(bytes: Uint8Array): DetectedFileType | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'png';
  }
  // RIFF....WEBP
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'webp';
  }
  return null;
}

export function extensionFor(type: DetectedFileType): string {
  return type === 'jpeg' ? 'jpg' : type;
}

export function mimeFor(type: DetectedFileType): string {
  return type === 'pdf' ? 'application/pdf' : `image/${type}`;
}
