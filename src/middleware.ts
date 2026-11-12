import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

import { mustChangePassword, passwordGate } from '@/lib/auth/username'

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // A one-time password login must choose its own password first:
  // only /set-password and its API are open until then. getUser() is
  // a GoTrue round trip, so the flag is current, not the JWT's copy.
  if (user) {
    const gate = passwordGate(request.nextUrl.pathname, mustChangePassword(user))
    if (gate === 'forbid') {
      return NextResponse.json({ error: 'Set your password first' }, { status: 403 })
    }
    if (gate === 'to-set-password' || gate === 'to-dashboard') {
      const url = request.nextUrl.clone()
      url.pathname = gate === 'to-set-password' ? '/set-password' : '/dashboard'
      url.search = ''
      return NextResponse.redirect(url)
    }
  }

  // Auth pages - redirect to dashboard if already logged in.
  if (user && (
    request.nextUrl.pathname === '/login' ||
    request.nextUrl.pathname === '/forgot-password'
  )) {
    const url = request.nextUrl.clone()
    url.pathname = '/dashboard'
    url.search = ''
    return NextResponse.redirect(url)
  }

  // Protected pages - redirect to login if not authenticated.
  //
  // This list has to stay in step with the sidebar's navItems. It had drifted:
  // /queue, /applications, /reports, /analytics and /flows all shipped after it
  // was written and were never added, so a logged-out visitor got an empty
  // client-rendered shell instead of the login page. No data was exposed (those
  // pages fetch nothing without an accountId, and RLS grants anon no rows), but
  // the intended behaviour is a redirect, and a page that renders for a signed-
  // out visitor is one careless server component away from being a real leak.
  const protectedPaths = [
    '/dashboard',
    '/inbox',
    '/queue',
    '/contacts',
    '/follow-ups',
    '/pipelines',
    '/applications',
    '/reports',
    '/analytics',
    '/growth',
    '/broadcasts',
    '/automations',
    '/flows',
    '/settings',
    '/set-password',
  ]
  if (!user && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // API routes that need auth (not webhooks)
  if (!user && request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
      !request.nextUrl.pathname.includes('/webhook')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    // api/bot is excluded: it authenticates with its own shared secret, never
    // a session, yet the old matcher ran a GoTrue round trip on every bot
    // request and threw its result away - a network hop on the hot path and a
    // shared fate with GoTrue the route was explicitly designed not to have.
    '/((?!_next/static|_next/image|favicon.ico|api/bot|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
