'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { allowed, clientIp, hit } from '../../lib/defense.ts'
import { redeemCode, requestCode } from '../../lib/lookup.ts'

const field = (f: FormData, k: string) => String(f.get(k) ?? '').trim()
const to = (q: Record<string, string>): never => redirect(`/lookup?${new URLSearchParams(q)}`)

// The answer is the same whether or not the order exists: the page never says which. Limits: per IP, and per order number (so one
// order's owner cannot be email-bombed). Real matches are mailed to the order's own address only.
export async function requestLookup(f: FormData) {
  const email = field(f, 'email').toLowerCase().slice(0, 200)
  const order = field(f, 'order').replace(/^#/, '')
  const q = { email, order }
  if (field(f, 'website')) return to({ ...q, step: 'code', notice: 'If those details match an order, we sent a code to its email.' }) // honeypot looks like success
  if (!allowed('lookup', clientIp(await headers()), null, 5)) return to({ ...q, error: 'Too many attempts, wait a minute' })
  if (!/^\S+@\S+\.\S+$/.test(email) || !/^\d{1,9}$/.test(order)) return to({ ...q, error: 'Enter your email and order number' })
  if (hit(`lookup:order:${order}`, 3, 3_600_000)) requestCode(email, Number(order))
  to({ ...q, step: 'code', notice: 'If those details match an order, we sent a code to its email.' })
}

export async function redeemLookup(f: FormData) {
  const email = field(f, 'email').toLowerCase()
  const order = field(f, 'order')
  const q = { email, order, step: 'code' }
  if (!allowed('lookup', clientIp(await headers()), null, 10)) return to({ ...q, error: 'Too many attempts, wait a minute' })
  const a = /^\d{1,9}$/.test(order) ? redeemCode(email, Number(order), field(f, 'code')) : undefined
  if (!a) return to({ ...q, error: 'That code is wrong or expired. Request a new one.' })
  // a guest order opens through its own access token (the same one in the confirmation email); an account order needs the login
  redirect(a.token ? `/orders/${a.orderId}?t=${encodeURIComponent(a.token)}` : `/login?next=${encodeURIComponent(`/orders/${a.orderId}`)}`)
}
