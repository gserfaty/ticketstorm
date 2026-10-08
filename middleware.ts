import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Marketing links: `?src=newsletter` is remembered in a 30-day cookie (a validated short slug only) and read at checkout, then stored on the order.
// A cookie rather than a sessions column because login replaces the session token; the cookie survives it.
export function middleware(req: NextRequest) {
  const src = req.nextUrl.searchParams.get('src')?.toLowerCase()
  const res = NextResponse.next()
  // visitor id for A/B bucketing: random, no personal data, one year
  if (!req.cookies.get('ab')) res.cookies.set('ab', crypto.randomUUID(), { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 365 * 86_400 })
  if (src && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(src)) res.cookies.set('src', src, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 30 * 86_400 })
  return res
}

export const config = { matcher: ['/((?!_next/|api/|embed/|favicon).*)'] }
