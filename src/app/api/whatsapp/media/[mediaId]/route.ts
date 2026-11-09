import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getPrimaryConfig } from '@/lib/whatsapp/config-resolver'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params

    if (!mediaId) {
      return NextResponse.json(
        { error: 'Media ID is required' },
        { status: 400 }
      )
    }

    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Resolve the caller's account_id — whatsapp_config is one-per-
    // account post-multi-user, so a teammate fetching media for a
    // conversation in the shared inbox needs the account's config,
    // not their personal (non-existent) row.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    // Only media of a message this person can see (RLS, with their own session):
    // since 094 that leaves out chats on a counsellor's own number for anyone
    // below admin. Every proxied attachment is stored on its message as
    // /api/whatsapp/media/<id>, so an id that no visible message points at is
    // not theirs to fetch.
    const { data: visible, error: visibleError } = await supabase
      .from('messages')
      .select('id')
      .eq('media_url', `/api/whatsapp/media/${mediaId}`)
      // The predicate of the partial index messages_proxied_media_url (094).
      .like('media_url', '/api/whatsapp/media/%')
      .limit(1)
    if (visibleError || !visible || visible.length === 0) {
      return NextResponse.json({ error: 'Media not found' }, { status: 404 })
    }

    // Fetch and decrypt WhatsApp config. Multi-number (034): media lives on the
    // shared WABA, so any of the account's numbers can fetch it — use the
    // primary config's token.
    let config
    try {
      config = await getPrimaryConfig(supabase, accountId)
    } catch {
      return NextResponse.json(
        { error: 'WhatsApp not configured' },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)

    // Get the download URL from Meta
    const mediaInfo = await getMediaUrl({ mediaId, accessToken })

    // Download the binary data
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    })

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': contentType || mediaInfo.mimeType || 'application/octet-stream',
        // private: a shared cache must not hand one member's media to another.
        'Cache-Control': 'private, max-age=86400',
      },
    })
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: 'Failed to fetch media' },
      { status: 500 }
    )
  }
}
