'use server'

import { redirect } from 'next/navigation'
import { completeExchange, exchangeable, otherDates } from '../../lib/exchange.ts'
import { HoldError, holdBestAvailable } from '../../lib/inventory.ts'
import { UserError } from '../../lib/platform.ts'
import { ensureSession, requireUser } from '../../lib/session.ts'

const num = (f: FormData, k: string) => Number(f.get(k))
const go = (ticketId: number, key: 'error' | 'notice', msg: string, extra = ''): never => redirect(`/tickets/${ticketId}/exchange?${key}=${encodeURIComponent(msg)}${extra}`)

// Step 1: hold one seat at the other date (the normal hold path, with all its gates), then show the price difference.
export async function holdForExchange(f: FormData) {
  const user = await requireUser()
  const ticketId = num(f, 'ticketId')
  const session = await ensureSession()
  try {
    const old = exchangeable(ticketId, user.id)
    const eventId = num(f, 'eventId')
    if (!otherDates(old).some((e) => e.id === eventId)) throw new UserError('Pick another date of the same series')
    const h = holdBestAvailable(eventId, { sessionToken: session, userId: user.id }, 1, num(f, 'levelId') || undefined)
    redirect(`/tickets/${ticketId}/exchange?hold=${h.holdId}`)
  } catch (e) {
    if (e instanceof UserError || e instanceof HoldError) go(ticketId, 'error', e.message)
    throw e
  }
}

// Step 2: one tx, see lib/exchange.ts.
export async function confirmExchange(f: FormData) {
  const user = await requireUser()
  const ticketId = num(f, 'ticketId')
  const session = await ensureSession()
  let orderId = 0
  try {
    orderId = completeExchange(ticketId, num(f, 'holdId'), user.id, session).orderId
  } catch (e) {
    if (e instanceof UserError || e instanceof HoldError) go(ticketId, 'error', e.message)
    throw e
  }
  redirect(`/orders/${orderId}?notice=${encodeURIComponent('Ticket exchanged')}`)
}
