import { randomBytes, timingSafeEqual } from 'node:crypto'
import { db, tx } from './db.ts'
import { assertTicketLimit, HoldError } from './inventory.ts'
import { paidOf, recordCharge, refundedOf, refundMoney } from './payments.ts'
import type { Method, Payment } from './payments.ts'
import { allocate, quote } from './pricing.ts'
import { ledgerAdd } from './ledger.ts'
import { settleListing } from './resale.ts'
import { alertUser, emailUser } from './alerts.ts'
import { APP_URL, notify } from './notify.ts'
import { money } from './format.ts'
import { fraudScore, REVIEW_AT } from './fraud.ts'
import { addInstallments, plan } from './installments.ts'
import { UserError } from './platform.ts'

export type PayInput = {
  holdId: number
  sessionToken: string
  userId: number | null
  email: string
  key: string
  method: Method // what the shopper chose; 'installments' is set here when `installments` is true
  installments?: boolean // pay in 4: first quarter now, the rest charged by the job (accounts only)
  brand: string
  last4: string
  exp: string
  save: boolean
  billing: { name: string; address: string; city: string; zip: string }
}
export type PayResult = { orderId: number } | { declined: string } | { threeDs: number } | { paypal: string }

// add-on kinds that get a scannable pass
export const PASS_KINDS = ['parking', 'hospitality']

type Meta = Pick<PayInput, 'userId' | 'email' | 'exp' | 'save' | 'billing'> & { total?: number; installments?: boolean } // total: full price when the payment is only the first quarter

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
  if (p.status === 'pending') return { paypal: p.idempotency_key } // PayPal: waiting for approval on the mock PayPal page
  return { declined: p.decline_code ?? 'declined' }
}

// One tx: hold check -> payment -> inventory sold -> order + items -> tickets -> hold converted.
// Throws HoldError (rolling everything back) if the hold is not live and yours. A decline commits only its payment row.
export function finalize(i: PayInput): PayResult {
  return tx(() => {
    const prior = db.prepare('SELECT * FROM payments WHERE idempotency_key = ?').get(i.key) as Payment | undefined
    if (prior) return resolve(prior, i.sessionToken)
    const hold = liveHold(i.holdId, i.sessionToken)
    if (!hold) throw new HoldError('Your hold expired or is not yours', 410)
    const q = quote(i.holdId)
    if (!q.lines.length) throw new HoldError('Nothing to buy', 410)
    if (q.promoError) throw new HoldError(q.promoError, 409)
    // bundle holds carry one line per game; only this event's own tickets count against this event's limit
    assertTicketLimit(i.userId, hold.event_id, q.lines.filter((l) => l.eventId === hold.event_id).length, i.sessionToken, i.email)
    const meta: Meta = { userId: i.userId, email: i.email, exp: i.exp, save: i.save, billing: i.billing }
    let amount = q.total
    let method = i.method
    if (i.installments) {
      if (!i.userId) throw new HoldError('Log in to pay in 4', 403)
      if (i.method === 'paypal') throw new HoldError('Pay in 4 is not available with PayPal', 409)
      const ev = db.prepare('SELECT starts_at FROM events WHERE id = ?').get(hold.event_id) as { starts_at: string }
      const parts = plan(q.total, ev.starts_at)
      if (!parts) throw new HoldError('Pay in 4 needs an order of at least $40 and a show at least 4 days away', 409)
      amount = parts[0].amount
      method = 'installments'
      meta.total = q.total
      meta.installments = true
    }
    const { payment } = recordCharge({ key: i.key, holdId: i.holdId, sessionToken: i.sessionToken, amount, method, brand: i.brand, last4: i.last4, meta })
    return resolve(payment, i.sessionToken)
  })
}

// Creates the order for a succeeded, order-less payment. Must run inside tx().
function createOrder(p: Payment): number {
  const now = new Date().toISOString()
  const hold = p.hold_id ? liveHold(p.hold_id, p.session_token!) : undefined
  if (!hold) throw new HoldError('Your hold expired', 410)
  const q = quote(hold.id)
  const m = JSON.parse(p.meta!) as Meta
  if (!q.lines.length || q.total !== (m.total ?? p.amount)) throw new HoldError('Price changed', 409)
  if (q.promoError) throw new HoldError(q.promoError, 409)

  // Resale hold: the seat is already sold; settle the listing (seller ticket 'resold', ledger credit) so the buyer's new ticket can be inserted below.
  // Otherwise: hold_id match + exact count, any row lost to another hold or expiry rolls the whole thing back.
  const listingId = q.lines[0].listingId
  if (listingId) settleListing(listingId, hold.id, m.userId)
  else {
    const sold = db.prepare("UPDATE inventory SET status = 'sold', held_until = NULL WHERE hold_id = ? AND status = 'held' AND held_until > ?").run(hold.id, now)
    if (sold.changes !== q.lines.length) throw new HoldError('Your tickets are no longer held', 409)
  }

  // Add-ons: one guarded UPDATE per add-on, so two buyers can never oversell the last one (a miss rolls the whole order, charge included, back).
  for (const a of q.addons) {
    if (db.prepare('UPDATE addons SET sold = sold + ? WHERE id = ? AND sold + ? <= inventory').run(a.qty, a.addonId, a.qty).changes !== 1) throw new HoldError(`${a.name} is sold out`, 409)
  }
  // Promo: the use is taken here, in the order's tx, only while uses < max_uses (and unexpired).
  if (q.promo && db.prepare('UPDATE promo_codes SET uses = uses + 1 WHERE id = ? AND uses < max_uses AND (expires_at IS NULL OR expires_at > ?)').run(q.promo.id, now).changes !== 1) {
    throw new HoldError('This promo code is no longer valid', 409)
  }

  const accessToken = randomBytes(16).toString('hex')
  const fraud = fraudScore({ userId: m.userId, billingCity: m.billing.city, total: q.total })
  const review = fraud.score >= REVIEW_AT
  const order = db
    .prepare(
      `INSERT INTO orders (user_id, session_token, access_token, email, event_id, hold_id, status, subtotal, fees, tax, protection, discount, promo_id, total, idempotency_key, fraud_score, review_reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    )
    .get(m.userId, p.session_token, accessToken, m.email, hold.event_id, hold.id, review ? 'review' : 'paid', q.subtotal, q.fees, q.tax, q.protection, q.discount, q.promo?.id ?? null, q.total, p.idempotency_key, fraud.score, review ? fraud.reasons.join(' + ') : null) as { id: number }
  const item = db.prepare("INSERT INTO order_items (order_id, kind, inventory_id, offer_id, unit_cents, fee_cents, tax_cents) VALUES (?, 'ticket', ?,?,?,?,?)")
  const ticket = db.prepare('INSERT INTO tickets (order_id, inventory_id, owner_id, secret) VALUES (?,?,?,?)')
  for (const l of q.lines) {
    item.run(order.id, l.inventoryId, l.offerId ?? null, l.unit, l.fee, l.tax)
    ticket.run(order.id, l.inventoryId, m.userId, randomBytes(32).toString('hex'))
  }
  // Add-on units: one item per unit. Parking and hospitality units also get a pass: a ticket with no seat (inventory_id NULL, addon_id set),
  // so it has its own secret and SafeTix QR and is scanned like any ticket. one_live_ticket ignores NULL inventory_id.
  for (const a of q.addons) {
    for (let n = 0; n < a.qty; n++) {
      db.prepare("INSERT INTO order_items (order_id, kind, addon_id, unit_cents, tax_cents) VALUES (?, 'addon', ?, ?, ?)").run(order.id, a.addonId, a.unit, a.taxEach)
      if (PASS_KINDS.includes(a.kind)) db.prepare('INSERT INTO tickets (order_id, addon_id, owner_id, secret) VALUES (?,?,?,?)').run(order.id, a.addonId, m.userId, randomBytes(32).toString('hex'))
    }
  }
  // the promo discount is its own (negative) line, and so is the per-order fee, so sum(items) == total
  if (q.discount) db.prepare("INSERT INTO order_items (order_id, kind, unit_cents) VALUES (?, 'discount', ?)").run(order.id, -q.discount)
  db.prepare("INSERT INTO order_items (order_id, kind, unit_cents, fee_cents, tax_cents) VALUES (?, 'fee', 0, ?, 0)").run(order.id, q.orderFee)
  if (q.protection) db.prepare("INSERT INTO order_items (order_id, kind, unit_cents) VALUES (?, 'protection', ?)").run(order.id, q.protection)
  db.prepare('UPDATE payments SET order_id = ? WHERE id = ?').run(order.id, p.id)
  db.prepare("UPDATE holds SET status = 'converted' WHERE id = ?").run(hold.id)
  if (m.save && m.userId) {
    db.prepare('INSERT OR IGNORE INTO saved_cards (user_id, brand, last4, exp, fake_token) VALUES (?,?,?,?,?)').run(m.userId, p.brand, p.last4, m.exp, 'tok_' + randomBytes(12).toString('hex'))
  }
  const ev = db.prepare('SELECT title, starts_at FROM events WHERE id = ?').get(hold.event_id) as { title: string; starts_at: string }
  if (m.installments) addInstallments(order.id, p, q.total, ev.starts_at)
  sendConfirmation(order.id)
  // the confirmation email above already reached the buyer; the inbox / SMS "tickets delivered" alert is recorded once per order
  if (m.userId && review) notify(m.userId, 'order', `Order #${order.id} is under review`, ev.title, `/orders/${order.id}`)
  else if (m.userId) alertUser(m.userId, 'orders', 'ticket_delivered', `order:${order.id}`, { title: `Order #${order.id} confirmed: your tickets are ready`, body: ev.title, link: `/orders/${order.id}` }, { email: false })
  return order.id
}

// The confirmation email (also what "Resend confirmation" sends). Links carry the order's access token so guests can open them.
export function sendConfirmation(orderId: number) {
  const o = db
    .prepare(
      `SELECT o.id, o.user_id, o.email, o.access_token, o.total, o.status, e.title, (SELECT count(*) FROM order_items WHERE order_id = o.id AND kind = 'ticket') AS n
       FROM orders o JOIN events e ON e.id = o.event_id WHERE o.id = ?`,
    )
    .get(orderId) as { id: number; user_id: number | null; email: string; access_token: string; total: number; status: string; title: string; n: number }
  const t = `?t=${o.access_token}`
  emailUser(
    o.user_id,
    'orders',
    o.email,
    `Your TicketStorm order #${o.id}`,
    `Thanks! ${o.n} ticket(s) for ${o.title}, total ${money(o.total)}.${o.status === 'review' ? '\nYour order is being reviewed; your tickets unlock when it is approved.' : ''}\nView your order and tickets: ${APP_URL}/orders/${o.id}${t}\nReceipt: ${APP_URL}/orders/${o.id}/receipt${t}`,
  )
}

// 3DS approval: finalizes like a normal payment (hold must still be live and yours).
export function approve3ds(paymentId: number, sessionToken: string): { orderId: number } | { declined: string } {
  try {
    return tx(() => {
      const p = db.prepare('SELECT * FROM payments WHERE id = ? AND session_token = ?').get(paymentId, sessionToken) as Payment | undefined
      if (!p) throw new HoldError('Payment not found', 404)
      // 3DS and PayPal both wait for the shopper on a bank / PayPal page; approving either finalizes the same way
      if (p.status === 'requires_3ds' || p.status === 'pending') db.prepare("UPDATE payments SET status = 'succeeded' WHERE id = ?").run(p.id)
      else if (p.status !== 'succeeded') return { declined: p.decline_code ?? 'declined' }
      return { orderId: p.order_id ?? createOrder({ ...p, status: 'succeeded' }) }
    })
  } catch (e) {
    if (e instanceof HoldError && e.status === 410) db.prepare("UPDATE payments SET status = 'declined', decline_code = 'hold_expired' WHERE id = ? AND status IN ('requires_3ds','pending')").run(paymentId)
    throw e
  }
}

export function fail3ds(paymentId: number, sessionToken: string, code = '3ds_failed'): number | undefined {
  const r = db
    .prepare("UPDATE payments SET status = 'declined', decline_code = ? WHERE id = ? AND session_token = ? AND status IN ('requires_3ds','pending') RETURNING hold_id")
    .get(code, paymentId, sessionToken) as { hold_id: number } | undefined
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
    .get(id) as (Owned & { id: number; email: string; status: string; subtotal: number; fees: number; tax: number; protection: number; discount: number; total: number; review_reason: string | null; refund_error: string | null; event_id: number; created_at: string; title: string; slug: string; starts_at: string; venue: string; tz: string }) | undefined
  return o && canViewOrder(o, v) ? o : undefined
}

// Ticket row incl. secret. Only call after getTicket authorised it.
export function getTicket(id: number, v: Viewer) {
  const t = db
    .prepare(
      `SELECT t.id, t.status, t.secret, t.owner_id, t.order_id, o.user_id, o.session_token, o.access_token, o.status AS order_status, e.title, e.starts_at, v.name AS venue, v.tz,
         s.name AS section, st.row, st.number, a.name AS addon
       FROM tickets t JOIN orders o ON o.id = t.order_id LEFT JOIN inventory i ON i.id = t.inventory_id LEFT JOIN addons a ON a.id = t.addon_id
       JOIN events e ON e.id = coalesce(i.event_id, a.event_id) JOIN venues v ON v.id = e.venue_id
       LEFT JOIN sections s ON s.id = i.section_id LEFT JOIN seats st ON st.id = i.seat_id WHERE t.id = ?`,
    )
    .get(id) as (Owned & { id: number; status: string; secret: string; owner_id: number | null; order_id: number; order_status: string; title: string; starts_at: string; venue: string; tz: string; section: string | null; row: string | null; number: number | null; addon: string | null }) | undefined
  if (!t) return undefined
  const ok = t.owner_id !== null ? v.userId === t.owner_id : canViewOrder({ ...t, user_id: null }, v)
  return ok ? t : undefined
}

// ---- refunds ----
// ONE function moves refund money and cancels what was refunded. Event cancellation, partial refunds, claims, fraud cancels, the rescheduled-event
// window and organizer tools all call it, so the caps live in one place: the amount is never more than paid minus already refunded (checked again
// in payments.refundMoney), an item can be refunded once, and a refunded ticket is cancelled in the same tx.
export type RefundOpts = {
  reason: string
  items?: number[] // order_items to refund on their own (tickets and add-ons). Default: everything that is left
  fees?: boolean // items only: also return their service fees and tax (default true)
  keepProtection?: boolean // a protection claim returns the tickets but not the premium
  refund?: boolean // false = void: cancel with no money back
  release?: boolean // put the seats back on sale (default). Event cancellation leaves them sold: the event is closed
  record?: boolean // a card that refuses the refund is recorded (order 'cancelled' + refund_error, admin retries) instead of rolling back
  quiet?: boolean // the caller sends its own message
}
export type RefundResult = { amount: number; ok: boolean; status: string }

// True while every live ticket of the order is still with the buyer. Self-service refunds and claims refuse otherwise: they would cancel
// tickets that now belong to someone who was sent or sold them.
export function heldByBuyer(orderId: number): boolean {
  return !db.prepare("SELECT 1 FROM tickets t JOIN orders o ON o.id = t.order_id WHERE t.order_id = ? AND t.status IN ('valid','listed','used') AND t.owner_id IS NOT o.user_id").get(orderId)
}

// Cancel one ticket: its listing and pending transfer die with it; its seat (or add-on unit) goes back on sale if `release`.
export function killTicket(id: number, release: boolean) {
  const t = db.prepare('SELECT inventory_id, addon_id, status FROM tickets WHERE id = ?').get(id) as { inventory_id: number | null; addon_id: number | null; status: string }
  db.prepare("UPDATE listings SET status = 'cancelled', hold_id = NULL, held_until = NULL WHERE ticket_id = ? AND status = 'active'").run(id)
  db.prepare("UPDATE transfers SET status = 'cancelled' WHERE ticket_id = ? AND status = 'pending'").run(id)
  db.prepare("UPDATE tickets SET status = 'cancelled' WHERE id = ?").run(id)
  if (!release || t.status === 'used') return
  if (t.inventory_id) db.prepare("UPDATE inventory SET status = 'available', hold_id = NULL, held_until = NULL WHERE id = ? AND status = 'sold'").run(t.inventory_id)
}

// Inside tx(). See RefundOpts.
function doRefund(orderId: number, opts: RefundOpts): RefundResult {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as
    | { id: number; user_id: number | null; email: string; status: string; refund_error: string | null; review_reason: string | null; discount: number; access_token: string; event_id: number }
    | undefined
  if (!o) throw new UserError('Order not found')
  if (!['paid', 'review', 'partially_refunded'].includes(o.status) && !(o.status === 'cancelled' && o.refund_error)) throw new UserError(`Order #${orderId} is ${o.status} and cannot be refunded`)
  const release = opts.release !== false
  const remaining = paidOf(orderId) - refundedOf(orderId)
  const live = "status IN ('valid','listed','used')"
  // void = cancel with no money back: only for orders with nothing left to refund (comps, unpaid); otherwise it would keep the buyer's money
  if (opts.refund === false && remaining > 0) throw new UserError('This order has money paid on it: use a refund, not void')
  // an item refund on a pay-in-4 order would leave installments that still charge the full price
  if (opts.items && db.prepare("SELECT 1 FROM payments WHERE order_id = ? AND status = 'pending'").get(orderId)) throw new UserError('Finish or cancel the pay-in-4 plan first: items cannot be refunded while installments are pending')

  let amount = 0
  const kill: number[] = []
  if (opts.items) {
    const items = db.prepare("SELECT id, kind, inventory_id, addon_id, unit_cents, fee_cents, tax_cents, refunded_cents FROM order_items WHERE order_id = ? AND kind IN ('ticket','addon') ORDER BY id").all(orderId) as
      { id: number; kind: string; inventory_id: number | null; addon_id: number | null; unit_cents: number; fee_cents: number; tax_cents: number; refunded_cents: number }[]
    const chosen = items.filter((x) => opts.items!.includes(x.id))
    if (!chosen.length || chosen.length !== new Set(opts.items).size) throw new UserError('Choose items from this order')
    // the promo discount is spread over the tickets the same way quote() spread it, so refunding every ticket never returns more than was paid
    const tix = items.filter((x) => x.kind === 'ticket')
    const share = allocate(tix.map((x) => x.unit_cents), o.discount)
    const taken = new Set<number>()
    for (const it of chosen) {
      if (it.refunded_cents > 0) throw new UserError('That item was already refunded')
      const own = it.kind === 'ticket' ? it.unit_cents - share[tix.indexOf(it)] : it.unit_cents
      const value = own + (opts.fees === false ? 0 : it.fee_cents + it.tax_cents)
      const t = db.prepare(`SELECT id FROM tickets WHERE order_id = ? AND ${it.kind === 'ticket' ? 'inventory_id' : 'addon_id'} = ? AND status IN ('valid','listed') ORDER BY id`).all(orderId, it.kind === 'ticket' ? it.inventory_id : it.addon_id) as { id: number }[]
      const ticket = t.find((x) => !taken.has(x.id))
      // seats and passes need a live ticket (used, resold and cancelled ones cannot be refunded on their own); merch has no ticket
      if (!ticket && (it.kind === 'ticket' || db.prepare('SELECT 1 FROM tickets WHERE order_id = ? AND addon_id = ?').get(orderId, it.addon_id))) throw new UserError('That ticket was already used, sold or cancelled')
      if (ticket) (taken.add(ticket.id), kill.push(ticket.id))
      else if (release) db.prepare('UPDATE addons SET sold = sold - 1 WHERE id = ? AND sold > 0').run(it.addon_id)
      db.prepare('UPDATE order_items SET refunded_cents = ? WHERE id = ?').run(Math.max(value, 1), it.id)
      amount += value
    }
    amount = Math.min(amount, remaining)
  } else {
    const prot = opts.keepProtection ? (db.prepare("SELECT coalesce(sum(unit_cents), 0) AS s FROM order_items WHERE order_id = ? AND kind = 'protection'").get(orderId) as { s: number }).s : 0
    amount = Math.max(remaining - prot, 0)
    kill.push(...(db.prepare(`SELECT id FROM tickets WHERE order_id = ? AND ${live}`).all(orderId) as { id: number }[]).map((t) => t.id))
    // pay-in-4: the installments still to come are cancelled with the order
    db.prepare("UPDATE payments SET status = 'declined', decline_code = 'voided' WHERE order_id = ? AND method = 'installments' AND status = 'pending'").run(orderId)
    if (release) db.prepare('UPDATE addons SET sold = sold - (SELECT count(*) FROM order_items WHERE order_id = ? AND addon_id = addons.id) WHERE id IN (SELECT addon_id FROM order_items WHERE order_id = ? AND kind = \'addon\')').run(orderId, orderId)
  }
  if (opts.refund === false) amount = 0

  const ok = amount > 0 ? refundMoney(orderId, amount) : true
  if (!ok && !opts.record) throw new UserError('The card refused the refund. Nothing was changed.')
  for (const id of kill) killTicket(id, release)

  const liveLeft = (db.prepare(`SELECT count(*) AS n FROM tickets WHERE order_id = ? AND ${live}`).get(orderId) as { n: number }).n
  // refunding part of an order that is under review does not release the rest of it
  const status = opts.refund === false || !ok ? 'cancelled' : opts.items && liveLeft > 0 ? (o.status === 'review' ? 'review' : 'partially_refunded') : 'refunded'
  db.prepare('UPDATE orders SET status = ?, refund_error = ?, review_reason = ? WHERE id = ?').run(status, ok ? null : 'refund_failed', status === 'review' ? o.review_reason : null, orderId)

  if (!opts.quiet) {
    const what = opts.refund === false ? `Order #${orderId} was cancelled.` : ok ? `We refunded ${money(amount)} for order #${orderId}.` : `Your refund of ${money(amount)} for order #${orderId} could not be completed yet; we will retry.`
    emailUser(o.user_id, 'orders', o.email, `Order #${orderId} update`, `${what}\n${APP_URL}/orders/${orderId}${o.user_id ? '' : `?t=${o.access_token}`}`)
    if (o.user_id) notify(o.user_id, 'order', `Order #${orderId} ${status.replace('_', ' ')}`, what, `/orders/${orderId}`)
  }
  return { amount, ok, status }
}

// Callers outside this file: one tx per refund (or call refundInTx inside a tx of your own).
export const refundInTx = doRefund
export const refundOrder = (orderId: number, opts: RefundOpts): RefundResult => tx(() => doRefund(orderId, opts))

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
    .prepare("SELECT id FROM orders WHERE event_id = ? AND (status IN ('paid','review','partially_refunded') OR (status = 'cancelled' AND refund_error IS NOT NULL)) ORDER BY id")
    .all(eventId) as { id: number }[]
  let refunded = 0
  let failed = 0
  for (const { id } of orders) {
    const ok = tx(() => {
      const o = db.prepare('SELECT user_id, email, status, access_token FROM orders WHERE id = ?').get(id) as { user_id: number | null; email: string; status: string; access_token: string }
      const r = doRefund(id, { reason: 'event_cancelled', release: false, record: true, quiet: true })
      const after = r.ok ? 'refunded' : 'cancelled'
      if (o.status !== after) {
        const link = `${APP_URL}/orders/${id}${o.user_id ? '' : `?t=${o.access_token}`}`
        emailUser(
          o.user_id,
          'orders',
          o.email,
          `${ev.title} has been cancelled`,
          r.ok ? `${ev.title} was cancelled. Your order #${id} was refunded in full (${money(r.amount)}).\n${link}` : `${ev.title} was cancelled. Your refund of ${money(r.amount)} for order #${id} could not be completed yet; we will retry and email you.\n${link}`,
        )
        if (o.user_id) notify(o.user_id, 'order', `${ev.title} was cancelled`, r.ok ? 'Your order was refunded.' : 'Your refund is pending.', `/orders/${id}`)
        // people the tickets were transferred or sold on to (not the buyer, who is notified above)
        for (const h of db.prepare('SELECT DISTINCT owner_id FROM tickets WHERE order_id = ? AND owner_id IS NOT NULL AND owner_id IS NOT ?').all(id, o.user_id) as { owner_id: number }[]) {
          notify(h.owner_id, 'order', `${ev.title} was cancelled`, 'Your ticket was cancelled.', '/tickets')
        }
      }
      return r.ok
    })
    if (ok) refunded++
    else failed++
  }
  return { refunded, failed }
}
