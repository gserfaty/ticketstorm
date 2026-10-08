import { randomBytes, timingSafeEqual } from 'node:crypto'
import { db, tx } from './db.ts'
import { HoldError } from './inventory.ts'
import { recordCharge, refund } from './payments.ts'
import type { Payment } from './payments.ts'
import { quote } from './pricing.ts'
import { ledgerAdd } from './ledger.ts'
import { settleListing } from './resale.ts'
import { APP_URL, notify, sendEmail } from './notify.ts'
import { money } from './format.ts'

export type PayInput = {
  holdId: number
  sessionToken: string
  userId: number | null
  email: string
  key: string
  method: 'card' | 'saved'
  brand: string
  last4: string
  exp: string
  save: boolean
  billing: { name: string; address: string; city: string; zip: string }
}
export type PayResult = { orderId: number } | { declined: string } | { threeDs: number }

type Meta = Pick<PayInput, 'userId' | 'email' | 'exp' | 'save' | 'billing'>

// The session's active, unexpired hold, or undefined. Ownership is the session token, never a user-supplied id alone.
export function liveHold(holdId: number, sessionToken: string) {
  return db
    .prepare("SELECT id, event_id, expires_at FROM holds WHERE id = ? AND session_token = ? AND status = 'active' AND expires_at > ?")
    .get(holdId, sessionToken, new Date().toISOString()) as { id: number; event_id: number; expires_at: string } | undefined
}

function resolve(p: Payment, sessionToken: string): PayResult {
  if (p.session_token !== sessionToken) throw new HoldError('Not your payment', 403)
  if (p.status === 'succeeded') return { orderId: p.order_id ?? createOrder(p) }
  if (p.status === 'requires_3ds') return { threeDs: p.id }
  return { declined: p.decline_code ?? 'declined' }
}

// One tx: hold check -> payment -> inventory sold -> order + items -> tickets -> hold converted.
// Throws HoldError (rolling everything back) if the hold is not live and yours. A decline commits only its payment row.
export function finalize(i: PayInput): PayResult {
  return tx(() => {
    const prior = db.prepare('SELECT * FROM payments WHERE idempotency_key = ?').get(i.key) as Payment | undefined
    if (prior) return resolve(prior, i.sessionToken)
    if (!liveHold(i.holdId, i.sessionToken)) throw new HoldError('Your hold expired or is not yours', 410)
    const q = quote(i.holdId)
    if (!q.lines.length) throw new HoldError('Nothing to buy', 410)
    const meta: Meta = { userId: i.userId, email: i.email, exp: i.exp, save: i.save, billing: i.billing }
    const { payment } = recordCharge({ key: i.key, holdId: i.holdId, sessionToken: i.sessionToken, amount: q.total, method: i.method, brand: i.brand, last4: i.last4, meta })
    return resolve(payment, i.sessionToken)
  })
}

// Creates the order for a succeeded, order-less payment. Must run inside tx().
function createOrder(p: Payment): number {
  const now = new Date().toISOString()
  const hold = p.hold_id ? liveHold(p.hold_id, p.session_token!) : undefined
  if (!hold) throw new HoldError('Your hold expired', 410)
  const q = quote(hold.id)
  if (!q.lines.length || q.total !== p.amount) throw new HoldError('Price changed', 409)
  const m = JSON.parse(p.meta!) as Meta

  // Resale hold: the seat is already sold; settle the listing (seller ticket 'resold', ledger credit) so the buyer's new ticket can be inserted below.
  // Otherwise: hold_id match + exact count, any row lost to another hold or expiry rolls the whole thing back.
  const listingId = q.lines[0].listingId
  if (listingId) settleListing(listingId, hold.id, m.userId)
  else {
    const sold = db.prepare("UPDATE inventory SET status = 'sold', held_until = NULL WHERE hold_id = ? AND status = 'held' AND held_until > ?").run(hold.id, now)
    if (sold.changes !== q.lines.length) throw new HoldError('Your tickets are no longer held', 409)
  }

  const accessToken = randomBytes(16).toString('hex')
  const order = db
    .prepare(
      `INSERT INTO orders (user_id, session_token, access_token, email, event_id, hold_id, status, subtotal, fees, tax, total, idempotency_key)
       VALUES (?,?,?,?,?,?, 'paid', ?,?,?,?,?) RETURNING id`,
    )
    .get(m.userId, p.session_token, accessToken, m.email, hold.event_id, hold.id, q.subtotal, q.fees, q.tax, q.total, p.idempotency_key) as { id: number }
  const item = db.prepare("INSERT INTO order_items (order_id, kind, inventory_id, unit_cents, fee_cents, tax_cents) VALUES (?, 'ticket', ?,?,?,?)")
  const ticket = db.prepare('INSERT INTO tickets (order_id, inventory_id, owner_id, secret) VALUES (?,?,?,?)')
  for (const l of q.lines) {
    item.run(order.id, l.inventoryId, l.unit, l.fee, l.tax)
    ticket.run(order.id, l.inventoryId, m.userId, randomBytes(32).toString('hex'))
  }
  // per-order processing fee as its own line, so sum(items) == total
  db.prepare("INSERT INTO order_items (order_id, kind, unit_cents, fee_cents, tax_cents) VALUES (?, 'fee', 0, ?, 0)").run(order.id, q.orderFee)
  db.prepare('UPDATE payments SET order_id = ? WHERE id = ?').run(order.id, p.id)
  db.prepare("UPDATE holds SET status = 'converted' WHERE id = ?").run(hold.id)
  if (m.save && m.userId) {
    db.prepare('INSERT OR IGNORE INTO saved_cards (user_id, brand, last4, exp, fake_token) VALUES (?,?,?,?,?)').run(m.userId, p.brand, p.last4, m.exp, 'tok_' + randomBytes(12).toString('hex'))
  }
  const ev = db.prepare('SELECT title FROM events WHERE id = ?').get(hold.event_id) as { title: string }
  sendEmail(
    m.email,
    `Your TicketStorm order #${order.id}`,
    `Thanks! ${q.lines.length} ticket(s) for ${ev.title}, total ${money(q.total)}.\nView your order and tickets: ${APP_URL}/orders/${order.id}?t=${accessToken}`,
  )
  if (m.userId) notify(m.userId, 'order', `Order #${order.id} confirmed`, ev.title, `/orders/${order.id}`)
  return order.id
}

// 3DS approval: finalizes like a normal payment (hold must still be live and yours).
export function approve3ds(paymentId: number, sessionToken: string): { orderId: number } | { declined: string } {
  try {
    return tx(() => {
      const p = db.prepare('SELECT * FROM payments WHERE id = ? AND session_token = ?').get(paymentId, sessionToken) as Payment | undefined
      if (!p) throw new HoldError('Payment not found', 404)
      if (p.status === 'requires_3ds') db.prepare("UPDATE payments SET status = 'succeeded' WHERE id = ?").run(p.id)
      else if (p.status !== 'succeeded') return { declined: p.decline_code ?? 'declined' }
      return { orderId: p.order_id ?? createOrder({ ...p, status: 'succeeded' }) }
    })
  } catch (e) {
    if (e instanceof HoldError && e.status === 410) db.prepare("UPDATE payments SET status = 'declined', decline_code = 'hold_expired' WHERE id = ? AND status = 'requires_3ds'").run(paymentId)
    throw e
  }
}

export function fail3ds(paymentId: number, sessionToken: string): number | undefined {
  const r = db
    .prepare("UPDATE payments SET status = 'declined', decline_code = '3ds_failed' WHERE id = ? AND session_token = ? AND status = 'requires_3ds' RETURNING hold_id")
    .get(paymentId, sessionToken) as { hold_id: number } | undefined
  return r?.hold_id
}

// ---- authorization: no sequential-id IDOR ----
export type Viewer = { userId: number | null; sessionToken: string | null; token?: string | null }
const same = (a?: string | null, b?: string | null) => !!a && !!b && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

type Owned = { user_id: number | null; session_token: string; access_token: string }
// User orders: the owner. Guest orders: the buying session or the emailed link token.
export const canViewOrder = (o: Owned, v: Viewer) => (o.user_id !== null ? v.userId === o.user_id : same(v.sessionToken, o.session_token) || same(v.token, o.access_token))

export function getOrder(id: number, v: Viewer) {
  const o = db
    .prepare(
      `SELECT o.*, e.title, e.slug, e.starts_at, v.name AS venue, v.tz FROM orders o JOIN events e ON e.id = o.event_id JOIN venues v ON v.id = e.venue_id WHERE o.id = ?`,
    )
    .get(id) as (Owned & { id: number; email: string; status: string; subtotal: number; fees: number; tax: number; total: number; created_at: string; title: string; slug: string; starts_at: string; venue: string; tz: string }) | undefined
  return o && canViewOrder(o, v) ? o : undefined
}

// Ticket row incl. secret. Only call after getTicket authorised it.
export function getTicket(id: number, v: Viewer) {
  const t = db
    .prepare(
      `SELECT t.id, t.status, t.secret, t.owner_id, t.order_id, o.user_id, o.session_token, o.access_token, e.title, e.starts_at, v.name AS venue, v.tz,
         s.name AS section, st.row, st.number
       FROM tickets t JOIN orders o ON o.id = t.order_id JOIN inventory i ON i.id = t.inventory_id JOIN events e ON e.id = i.event_id
       JOIN venues v ON v.id = e.venue_id JOIN sections s ON s.id = i.section_id LEFT JOIN seats st ON st.id = i.seat_id WHERE t.id = ?`,
    )
    .get(id) as (Owned & { id: number; status: string; secret: string; owner_id: number | null; order_id: number; title: string; starts_at: string; venue: string; tz: string; section: string; row: string | null; number: number | null }) | undefined
  if (!t) return undefined
  const ok = t.owner_id !== null ? v.userId === t.owner_id : canViewOrder({ ...t, user_id: null }, v)
  return ok ? t : undefined
}

// Cancel an event and fully refund every order. Safe to run again: refunded orders are skipped, and orders whose refund
// failed (card 0341) are retried. Each order is its own tx. A failed refund leaves the order 'cancelled' + refund_error
// (never 'refunded') so admin can see and retry it. Inventory stays sold: the event is closed, nothing can resell it.
// ponytail: a bundle order is refunded and cancelled whole when any one game in it is cancelled.
export function refundEvent(eventId: number): { refunded: number; failed: number } {
  const ev = db.prepare('SELECT title FROM events WHERE id = ?').get(eventId) as { title: string } | undefined
  if (!ev) throw new Error('No such event')
  tx(() => {
    db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(eventId)
    db.prepare("UPDATE inventory SET status = 'available', hold_id = NULL, held_until = NULL WHERE status = 'held' AND hold_id IN (SELECT id FROM holds WHERE event_id = ? AND status = 'active')").run(eventId)
    db.prepare("UPDATE holds SET status = 'released' WHERE event_id = ? AND status = 'active'").run(eventId)
    // resale listings and pending transfers die with the event
    const mine = "ticket_id IN (SELECT t.id FROM tickets t JOIN inventory i ON i.id = t.inventory_id WHERE i.event_id = ?)"
    db.prepare(`UPDATE listings SET status = 'cancelled', hold_id = NULL, held_until = NULL WHERE status = 'active' AND ${mine}`).run(eventId)
    db.prepare(`UPDATE transfers SET status = 'cancelled' WHERE status = 'pending' AND ${mine}`).run(eventId)
    // a resold ticket is refunded to both its original and its new order, so take the seller's credit back (once per listing)
    for (const l of db.prepare(`SELECT id, seller_id, price_cents FROM listings WHERE status = 'sold' AND ${mine}`).all(eventId) as { id: number; seller_id: number; price_cents: number }[]) {
      if (!db.prepare('SELECT 1 FROM ledger WHERE ref = ?').get(`listing:${l.id}:reversal`)) ledgerAdd(`user:${l.seller_id}`, 'resale_credit', -l.price_cents, `listing:${l.id}:reversal`)
    }
  })
  const orders = db
    .prepare("SELECT id FROM orders WHERE event_id = ? AND (status IN ('paid','review') OR (status = 'cancelled' AND refund_error IS NOT NULL)) ORDER BY id")
    .all(eventId) as { id: number }[]
  let refunded = 0
  let failed = 0
  for (const { id } of orders) {
    const ok = tx(() => {
      const o = db.prepare('SELECT user_id, email, status, access_token FROM orders WHERE id = ?').get(id) as { user_id: number | null; email: string; status: string; access_token: string }
      const charge = db.prepare("SELECT id FROM payments WHERE order_id = ? AND kind = 'charge' AND status = 'succeeded'").get(id) as { id: number } | undefined
      const done = db.prepare("SELECT 1 FROM payments WHERE order_id = ? AND kind = 'refund' AND status = 'succeeded'").get(id)
      const amount = (db.prepare('SELECT coalesce(sum(unit_cents + fee_cents + tax_cents), 0) AS s FROM order_items WHERE order_id = ?').get(id) as { s: number }).s
      // free comps / no charge: nothing to refund
      const ok = done || !charge || amount === 0 ? true : refund(charge.id, amount)
      db.prepare("UPDATE tickets SET status = 'cancelled' WHERE order_id = ? AND status IN ('valid','listed','used')").run(id)
      db.prepare('UPDATE orders SET status = ?, refund_error = ? WHERE id = ?').run(ok ? 'refunded' : 'cancelled', ok ? null : 'refund_failed', id)
      const after = ok ? 'refunded' : 'cancelled'
      if (o.status !== after) {
        const link = `${APP_URL}/orders/${id}${o.user_id ? '' : `?t=${o.access_token}`}`
        sendEmail(
          o.email,
          `${ev.title} has been cancelled`,
          ok ? `${ev.title} was cancelled. Your order #${id} was refunded in full (${money(amount)}).\n${link}` : `${ev.title} was cancelled. Your refund of ${money(amount)} for order #${id} could not be completed yet; we will retry and email you.\n${link}`,
        )
        if (o.user_id) notify(o.user_id, 'order', `${ev.title} was cancelled`, ok ? 'Your order was refunded.' : 'Your refund is pending.', `/orders/${id}`)
        // people the tickets were transferred or sold on to (not the buyer, who is notified above)
        for (const h of db.prepare('SELECT DISTINCT owner_id FROM tickets WHERE order_id = ? AND owner_id IS NOT NULL AND owner_id IS NOT ?').all(id, o.user_id) as { owner_id: number }[]) {
          notify(h.owner_id, 'order', `${ev.title} was cancelled`, 'Your ticket was cancelled.', '/tickets')
        }
      }
      return ok
    })
    if (ok) refunded++
    else failed++
  }
  return { refunded, failed }
}
