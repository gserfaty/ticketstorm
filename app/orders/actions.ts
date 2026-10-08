'use server'

import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { db } from '../../lib/db.ts'
import { allowed, clientIp } from '../../lib/defense.ts'
import { getOrder, heldByBuyer, refundOrder, sendConfirmation } from '../../lib/orders.ts'
import { UserError } from '../../lib/platform.ts'
import { submitClaim } from '../../lib/protection.ts'
import { getUser, getViewer, refuseImpersonation } from '../../lib/session.ts'

const field = (f: FormData, k: string) => String(f.get(k) ?? '').trim()

// Same authorization as the order page: owner, or the guest's session / emailed token. Anything else is a 404.
async function authorised(f: FormData) {
  const t = field(f, 't')
  const o = getOrder(Number(field(f, 'orderId')), await getViewer(t || null))
  if (!o) notFound()
  return { o: o!, back: `/orders/${o!.id}${t ? `?t=${encodeURIComponent(t)}` : ''}` }
}
const sep = (back: string) => (back.includes('?') ? '&' : '?')
const done = (back: string, key: 'notice' | 'error', msg: string): never => redirect(`${back}${sep(back)}${key}=${encodeURIComponent(msg)}`)

export async function resendConfirmation(f: FormData) {
  const { o, back } = await authorised(f)
  if (!allowed('resend', clientIp(await headers()), (await getUser())?.id ?? null, 3)) done(back, 'error', 'Too many requests, wait a minute')
  sendConfirmation(o.id)
  done(back, 'notice', `Confirmation sent to ${o.email}`)
}

// Refund button for a rescheduled event: only inside events.refund_window_until, only while nothing was used or passed on.
export async function requestRefund(f: FormData) {
  await refuseImpersonation()
  const { o, back } = await authorised(f)
  try {
    const e = db.prepare('SELECT status, refund_window_until FROM events WHERE id = ?').get(o.event_id) as { status: string; refund_window_until: string | null }
    if (e.status !== 'rescheduled' || !e.refund_window_until || e.refund_window_until <= new Date().toISOString()) throw new UserError('The refund window for this event is closed')
    if (!['paid', 'partially_refunded'].includes(o.status)) throw new UserError(`An order that is ${o.status} cannot be refunded`)
    if (db.prepare("SELECT 1 FROM tickets WHERE order_id = ? AND status = 'used'").get(o.id)) throw new UserError('Tickets that were already scanned cannot be refunded')
    if (!heldByBuyer(o.id)) throw new UserError('Some of these tickets were transferred or sold, so the order cannot be refunded here')
    refundOrder(o.id, { reason: 'rescheduled_window' })
  } catch (e) {
    if (e instanceof UserError) done(back, 'error', e.message)
    throw e
  }
  done(back, 'notice', 'Refund issued')
}

export async function fileClaim(f: FormData) {
  await refuseImpersonation()
  const { o, back } = await authorised(f)
  try {
    submitClaim(o.id, field(f, 'reason'), field(f, 'details'))
  } catch (e) {
    if (e instanceof UserError) done(back, 'error', e.message)
    throw e
  }
  done(back, 'notice', 'Claim submitted. We will email you when it is decided.')
}
