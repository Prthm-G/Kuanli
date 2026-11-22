import { beforeEach, describe, expect, it, vi } from 'vitest';

// The media proxy (094 follow-up): only media of a message the caller can see
// under RLS, and never cached by a shared cache. Made-up ids.

const h = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  visible: [] as { id: string }[],
  visibleError: null as unknown,
  messageFilters: [] as [string, unknown][],
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
  getPrimaryConfig: vi.fn(async () => ({ access_token: 'enc' })),
  admin: { service: true },
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
    from: (table: string) => {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { account_id: 'acc-1' } }),
            }),
          }),
        };
      }
      // messages, read with the caller's own session (RLS applies)
      return {
        select: () => ({
          eq: (c: string, v: unknown) => {
            h.messageFilters.push([c, v]);
            return {
              like: (lc: string, lv: unknown) => {
                h.messageFilters.push([`like ${lc}`, lv]);
                return {
                  limit: async () => ({
                    data: h.visible,
                    error: h.visibleError,
                  }),
                };
              },
            };
          },
        }),
      };
    },
  }),
}));
vi.mock('@/lib/whatsapp/config-resolver', () => ({
  getPrimaryConfig: h.getPrimaryConfig,
}));
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => h.admin }));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'token' }));
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: h.getMediaUrl,
  downloadMedia: h.downloadMedia,
}));

import { GET } from './route';

const get = (id: string) =>
  GET(new Request(`http://localhost/api/whatsapp/media/${id}`), {
    params: Promise.resolve({ mediaId: id }),
  });

describe('GET /api/whatsapp/media/[mediaId]', () => {
  beforeEach(() => {
    h.user = { id: 'user-1' };
    h.visible = [];
    h.visibleError = null;
    h.messageFilters = [];
    h.getMediaUrl.mockResolvedValue({
      url: 'https://cdn.example.invalid/x',
      mimeType: 'image/jpeg',
    });
    h.downloadMedia.mockResolvedValue({
      buffer: Buffer.from('abc'),
      contentType: 'image/jpeg',
    });
  });

  it('401 without a session', async () => {
    h.user = null;
    expect((await get('9000000000001')).status).toBe(401);
    expect(h.getMediaUrl).not.toHaveBeenCalled();
  });

  it('404, and no Meta call, when no message the caller can see points at that media', async () => {
    const res = await get('9000000000001');
    expect(res.status).toBe(404);
    expect(h.messageFilters).toEqual([
      ['media_url', '/api/whatsapp/media/9000000000001'],
      ['like media_url', '/api/whatsapp/media/%'],
    ]);
    expect(h.getMediaUrl).not.toHaveBeenCalled();
  });

  it('404 when the lookup fails (fail closed)', async () => {
    h.visible = [{ id: 'm1' }];
    h.visibleError = { message: 'timeout' };
    expect((await get('9000000000001')).status).toBe(404);
    expect(h.getMediaUrl).not.toHaveBeenCalled();
  });

  it('proxies media of a visible message, with a private cache header', async () => {
    h.visible = [{ id: 'm1' }];
    const res = await get('9000000000001');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=86400');
    expect(h.getMediaUrl).toHaveBeenCalledWith({
      mediaId: '9000000000001',
      accessToken: 'token',
    });
  });

  it('reads the token with the service client, for the caller\'s own account (099)', async () => {
    h.visible = [{ id: 'm1' }];
    await get('9000000000001');
    expect(h.getPrimaryConfig).toHaveBeenCalledWith(h.admin, 'acc-1');
  });

  // KB-FIXPASS-20261122: media Meta no longer holds is gone for good.
  it('410 with one warning line when Meta no longer has the media', async () => {
    h.visible = [{ id: 'm1' }];
    h.getMediaUrl.mockRejectedValueOnce(
      new Error(
        "Unsupported get request. Object with ID '9000000000001' does not exist, cannot be loaded due to missing permissions, or does not support this operation."
      )
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await get('9000000000001');
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({
      error: 'Media no longer available on WhatsApp',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });

  it('500 and the full error for any other failure', async () => {
    h.visible = [{ id: 'm1' }];
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const failure of [
      new TypeError('fetch failed'),
      new Error('relation "whatever" does not exist'),
      new Error('Error validating access token: Session has expired'),
    ]) {
      h.getMediaUrl.mockRejectedValueOnce(failure);
      expect((await get('9000000000001')).status).toBe(500);
    }
    expect(error).toHaveBeenCalledTimes(3);
    error.mockRestore();
  });
});
