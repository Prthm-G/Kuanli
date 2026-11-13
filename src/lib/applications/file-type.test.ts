import { describe, expect, it } from 'vitest';

import { detectFileType, extensionFor, mimeFor } from './file-type';

const bytes = (...b: number[]) => new Uint8Array(b);
const ascii = (s: string) => Array.from(s).map((c) => c.charCodeAt(0));

describe('detectFileType', () => {
  it('recognises a PDF by its header', () => {
    expect(detectFileType(bytes(...ascii('%PDF-1.7\n'), 0, 1))).toBe('pdf');
  });

  it('recognises a JPEG', () => {
    expect(detectFileType(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10))).toBe('jpeg');
  });

  it('recognises a PNG', () => {
    expect(
      detectFileType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))
    ).toBe('png');
  });

  it('recognises a WebP (RIFF container with a WEBP form)', () => {
    expect(
      detectFileType(
        bytes(...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WEBP'), ...ascii('VP8 '))
      )
    ).toBe('webp');
  });

  it('refuses a RIFF file that is not WebP', () => {
    expect(
      detectFileType(bytes(...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WAVE')))
    ).toBeNull();
  });

  it('refuses other formats and text, whatever the file is called', () => {
    // A script or a zip renamed to .pdf has the wrong bytes.
    expect(
      detectFileType(bytes(...ascii('<script>alert(1)</script>')))
    ).toBeNull();
    expect(detectFileType(bytes(0x50, 0x4b, 0x03, 0x04))).toBeNull();
    expect(detectFileType(bytes(...ascii('GIF89a')))).toBeNull();
  });

  it('refuses empty and truncated input', () => {
    expect(detectFileType(new Uint8Array(0))).toBeNull();
    expect(detectFileType(bytes(0xff, 0xd8))).toBeNull();
    expect(detectFileType(bytes(...ascii('%PDF')))).toBeNull();
  });
});

describe('extensionFor / mimeFor', () => {
  it('maps each detected type', () => {
    expect(extensionFor('jpeg')).toBe('jpg');
    expect(extensionFor('pdf')).toBe('pdf');
    expect(mimeFor('jpeg')).toBe('image/jpeg');
    expect(mimeFor('webp')).toBe('image/webp');
    expect(mimeFor('png')).toBe('image/png');
    expect(mimeFor('pdf')).toBe('application/pdf');
  });
});
