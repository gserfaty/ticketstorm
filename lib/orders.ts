import { randomBytes, timingSafeEqual } from 'node:crypto'
import { db, tx } from './db.ts'
import { HoldError } from './inventory.ts'
import { recordCharge } from './payments.ts'
import type { Payment } from './payments.ts'
import { quote } from './pricing.ts'
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

  // hold_id match + exact count: any row lost to another hold or expiry rolls the whole thing back
  const sold = db.prepare("UPDATE inventory SET status = 'sold', held_until = NULL WHERE hold_id = ? AND status = 'held' AND held_until > ?").run(hold.id, now)
  if (sold.changes !== q.lines.length) throw new HoldError('Your tickets are no longer held', 409)

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
