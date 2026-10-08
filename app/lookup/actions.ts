'use server'

import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { allowed, clientIp, hit } from '../../lib/defense.ts'
import { LOOKUP_TTL_MS, lookupCookie, orderMatches, readLookupCookie, redeemCode, requestCode } from '../../lib/lookup.ts'

const field = (f: FormData, k: string) => String(f.get(k) ?? '').trim()
const to = (q: Record<string, string>): never => redirect(`/lookup?${new URLSearchParams(q)}`)
const SENT = 'If those details match an order, we sent a code to its email.'

// The answer is the same whether or not the order exists. The IP limit counts every request; the per-order limit (so an owner cannot be
// email-bombed) counts only requests whose email matches, so a stranger guessing order numbers cannot use up the real owner's allowance.
// Email and order number stay out of URLs: the pair is kept in a signed httpOnly cookie for the code step.
export async function requestLookup(f: FormData) {
  const email = field(f, 'email').toLowerCase().slice(0, 200)
  const order = field(f, 'order').replace(/^#/, '')
  if (!field(f, 'website')) {
    if (!allowed('lookup', clientIp(await headers()), null, 5)) return to({ error: 'Too many attempts, wait a minute' })
    if (!/^\S+@\S+\.\S+$/.test(email) || !/^\d{1,9}$/.test(order)) return to({ error: 'Enter your email and order number' })
    if (orderMatches(email, Number(order)) && hit(`lookup:order:${order}`, 3, 3_600_000)) requestCode(email, Number(order))
    ;(await cookies()).set('lookup', lookupCookie(email, Number(order)), { httpOnly: true, sameSite: 'lax', path: '/lookup', maxAge: LOOKUP_TTL_MS / 1000 })
  }
  to({ step: 'code', notice: SENT })
}

export async function redeemLookup(f: FormData) {
  const pending = readLookupCookie((await cookies()).get('lookup')?.value)
  if (!pending) return to({ error: 'Start again: enter your email and order number' })
  if (!allowed('lookup', clientIp(await headers()), null, 10)) return to({ step: 'code', error: 'Too many attempts, wait a minute' })
  const a = redeemCode(pending.email, pending.orderId, field(f, 'code'))
  if (!a) return to({ step: 'code', error: 'That code is wrong or expired. Request a new one.' })
  ;(await cookies()).delete('lookup')
  redirect(a.token ? `/orders/${a.orderId}?t=${encodeURIComponent(a.token)}` : `/login?next=${encodeURIComponent(`/orders/${a.orderId}`)}`)
}
