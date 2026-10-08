import { randomBytes } from 'node:crypto'
import { db, tx } from './db.ts'
import { eventState } from './events.ts'
import { assertTicketLimit, HoldError } from './inventory.ts'
import { chargeStored, refundMoney } from './payments.ts'
import { killTicket, liveHold, sendConfirmation } from './orders.ts'
import { quote } from './pricing.ts'
import { notify } from './notify.ts'
import { UserError } from './platform.ts'

// Exchange = move one ticket to a seat at another date of the same series (events.series_key). The shopper first HOLDS the new seat with the
// normal hold path, then completeExchange does everything in one tx: new order + ticket for the new seat, old ticket cancelled and its seat
// freed, and the price difference charged to the card the old order was paid with (or refunded to it).
// Money: the value of the old ticket moves to the new order as an 'exchange' credit (payments rows on both orders, nothing leaves TicketStorm);
// only the difference touches the card. The new order is its own order for the new event, so refundEvent, limits and organizer tools stay per event.

// ponytail: promo, bundle and pay-in-4 orders cannot be exchanged; handle them by splitting the discount share / settling the plan first.
type Old = { ticketId: number; orderId: number; eventId: number; seriesKey: string; value: number; itemId: number; email: string }

// The ticket must be the caller's, valid, on a paid order, for an upcoming show of a series. Not supported: promo orders (the discount share
// would need re-splitting), bundle seats, orders still paying in installments.
export function exchangeable(ticketId: number, userId: number): Old {
  const t = db
    .prepare(
      `SELECT t.id, t.status, t.owner_id, t.order_id, t.inventory_id, o.status AS ostatus, o.discount, o.email, e.id AS event_id, e.series_key, e.starts_at, pl.event_ids,
         oi.id AS item_id, oi.unit_cents + oi.fee_cents + oi.tax_cents AS value, oi.refunded_cents
       FROM tickets t JOIN orders o ON o.id = t.order_id JOIN inventory i ON i.id = t.inventory_id JOIN events e ON e.id = i.event_id
       JOIN price_levels pl ON pl.id = i.price_level_id
       JOIN order_items oi ON oi.order_id = t.order_id AND oi.inventory_id = t.inventory_id AND oi.kind = 'ticket'
       WHERE t.id = ?`,
    )
    .get(ticketId) as
    | { id: number; status: string; owner_id: number | null; order_id: number; ostatus: string; discount: number; email: string; event_id: number; series_key: string | null; starts_at: string; event_ids: string | null; item_id: number; value: number; refunded_cents: number }
    | undefined
  if (!t || t.owner_id !== userId) throw new HoldError('Ticket not found', 404)
  if (t.status !== 'valid' || !['paid', 'partially_refunded'].includes(t.ostatus) || t.refunded_cents) throw new UserError('This ticket cannot be exchanged')
  if (!t.series_key) throw new UserError('This event has no other dates')
  if (Date.parse(t.starts_at) <= Date.now()) throw new UserError('This show has already started')
  if (t.discount > 0) throw new UserError('Orders paid with a promo code cannot be exchanged')
  if (t.event_ids) throw new UserError('Bundle tickets cannot be exchanged')
  if (db.prepare("SELECT 1 FROM payments WHERE order_id = ? AND status = 'pending'").get(t.order_id)) throw new UserError('Finish paying your pay-in-4 order before exchanging')
  return { ticketId, orderId: t.order_id, eventId: t.event_id, seriesKey: t.series_key, value: t.value, itemId: t.item_id, email: t.email }
}

// Other upcoming dates of the same series that are on sale.
export function otherDates(old: Pick<Old, 'seriesKey' | 'eventId'>) {
  const rows = db
    .prepare(
      `SELECT e.id, e.slug, e.title, e.status, e.starts_at, e.onsale_at, v.name AS venue, v.tz FROM events e JOIN venues v ON v.id = e.venue_id
       WHERE e.series_key = ? AND e.id != ? AND e.approved = 1 AND e.status IN ('published','rescheduled') AND e.starts_at > ? ORDER BY e.starts_at`,
    )
    .all(old.seriesKey, old.eventId, new Date().toISOString()) as { id: number; slug: string; title: string; status: string; starts_at: string; onsale_at: string | null; venue: string; tz: string }[]
  return rows.filter((e) => eventState(e).canBuy)
}

// What the held seat costs all-in (face + service/facility fee + tax; the per-order fee is not charged again) against what the old ticket cost.
function priceOf(holdId: number, old: Old, userId: number, sessionToken: string) {
  const hold = liveHold(holdId, sessionToken)
  const h = hold && (db.prepare('SELECT user_id, event_id FROM holds WHERE id = ?').get(holdId) as { user_id: number | null; event_id: number })
  if (!hold || h!.user_id !== userId) throw new HoldError('Your hold expired', 410)
  const q = quote(holdId)
  if (q.lines.length !== 1 || q.lines[0].listingId || q.addons.length) throw new UserError('Hold exactly one seat to exchange')
  const e = db.prepare('SELECT series_key FROM events WHERE id = ?').get(h!.event_id) as { series_key: string | null }
  if (e.series_key !== old.seriesKey || h!.event_id === old.eventId) throw new UserError('Pick another date of the same series')
  const line = q.lines[0]
  const value = line.unit + line.fee + line.tax
  return { line, eventId: h!.event_id, value, diff: value - old.value }
}

export function previewExchange(ticketId: number, holdId: number, userId: number, sessionToken: string) {
  const old = exchangeable(ticketId, userId)
  return { old, ...priceOf(holdId, old, userId, sessionToken) }
}

export function completeExchange(ticketId: number, holdId: number, userId: number, sessionToken: string): { orderId: number; diff: number } {
  return tx(() => {
    const old = exchangeable(ticketId, userId)
    const n = priceOf(holdId, old, userId, sessionToken)
    assertTicketLimit(userId, n.eventId, 1, sessionToken, old.email)
    const order = db
      .prepare(
        `INSERT INTO orders (user_id, session_token, access_token, email, event_id, hold_id, status, subtotal, fees, tax, total, source, idempotency_key)
         VALUES (?,?,?,?,?,?, 'paid', ?,?,?,?, 'exchange', ?) RETURNING id`,
      )
      .get(userId, sessionToken, randomBytes(16).toString('hex'), old.email, n.eventId, holdId, n.line.unit, n.line.fee, n.line.tax, n.value, `exchange-${holdId}`) as { id: number }
    db.prepare("INSERT INTO order_items (order_id, kind, inventory_id, unit_cents, fee_cents, tax_cents) VALUES (?, 'ticket', ?,?,?,?)").run(order.id, n.line.inventoryId, n.line.unit, n.line.fee, n.line.tax)
    if (db.prepare("UPDATE inventory SET status = 'sold', held_until = NULL WHERE hold_id = ? AND status = 'held' AND held_until > ?").run(holdId, new Date().toISOString()).changes !== 1) throw new HoldError('Your seat is no longer held', 409)
    db.prepare("UPDATE holds SET status = 'converted' WHERE id = ?").run(holdId)
    db.prepare('INSERT INTO tickets (order_id, inventory_id, owner_id, secret) VALUES (?,?,?,?)').run(order.id, n.line.inventoryId, userId, randomBytes(32).toString('hex'))

    // old ticket out, its seat back on sale, its item marked refunded
    killTicket(ticketId, true)
    db.prepare('UPDATE order_items SET refunded_cents = ? WHERE id = ?').run(Math.max(old.value, 1), old.itemId)
    // money: the smaller of the two prices moves across as credit, then only the difference touches the card
    const credit = Math.min(old.value, n.value)
    if (credit > 0) refundMoney(old.orderId, credit, 'exchange', order.id)
    if (n.diff > 0) {
      const p = chargeStored(old.orderId, order.id, n.diff, `exchange-${holdId}-diff`)
      if (p.status !== 'succeeded') throw new UserError('Your card was declined for the price difference. Nothing was changed.')
    } else if (n.diff < 0 && !refundMoney(old.orderId, -n.diff)) throw new UserError('The card refused the refund of the price difference. Nothing was changed.')
    const live = (db.prepare("SELECT count(*) AS n FROM tickets WHERE order_id = ? AND status IN ('valid','listed','used')").get(old.orderId) as { n: number }).n
    db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(live ? 'partially_refunded' : 'refunded', old.orderId)
    db.prepare('INSERT INTO exchanges (from_ticket, to_inventory, from_order, to_order, diff_cents) VALUES (?,?,?,?,?)').run(ticketId, n.line.inventoryId, old.orderId, order.id, n.diff)
    sendConfirmation(order.id)
    notify(userId, 'order', 'Ticket exchanged', `New order #${order.id}`, `/orders/${order.id}`)
    return { orderId: order.id, diff: n.diff }
  })
}
