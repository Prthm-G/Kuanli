import { describe, expect, it, vi } from 'vitest';

import { fetchMediaAsFile } from './media-file';

const png = () =>
  new Response(new Blob(['x'], { type: 'image/png' }), { status: 200 });

describe('fetchMediaAsFile', () => {
  it('turns a proxied chat image into a File named for the extension', async () => {
    const fetchImpl = vi.fn(async () => png());
    const file = await fetchMediaAsFile('/api/whatsapp/media/8096', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith('/api/whatsapp/media/8096');
    expect(file.type).toBe('image/png');
    expect(file.name).toMatch(/^chat-image\.png$/);
    expect(file.size).toBe(1);
  });

  it('works for a mirrored chat-media URL too', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(new Blob(['x'], { type: 'image/jpeg' }), { status: 200 })
    );
    const file = await fetchMediaAsFile(
      'https://files.example.invalid/chat-media/a.jpg',
      fetchImpl
    );
    expect(file.name).toBe('chat-image.jpg');
  });

  it('throws on a failed fetch', async () => {
    const fetchImpl = vi.fn(async () => new Response('no', { status: 404 }));
    await expect(
      fetchMediaAsFile('/api/whatsapp/media/8096', fetchImpl)
    ).rejects.toThrow(/could not load/i);
  });

  it('refuses something that is not an image', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(new Blob(['x'], { type: 'text/html' }), { status: 200 })
    );
    await expect(
      fetchMediaAsFile('/api/whatsapp/media/8096', fetchImpl)
    ).rejects.toThrow(/image/i);
  });
});
