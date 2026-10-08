import { randomBytes } from 'node:crypto'
import { db, tx } from './db.ts'
import { likeEscape } from './format.ts'
import { killTicket, refundOrder } from './orders.ts'
import { APP_URL, notify, sendEmail } from './notify.ts'
import { UserError } from './platform.ts'

// Organizer order management for one event. Callers authorise the actor for the org that owns the order's event; nothing here trusts a form.
export const ORDER_ROLES = ['owner', 'manager', 'box_office']

export type OrderRow = { id: number; email: string; name: string | null; status: string; total: number; paid: number; refunded: number; review_reason: string | null; source: string | null; created_at: string }

// By order number, email or account name. Newest first, 50 at most.
export function searchOrders(eventId: number, q: string, status: string): OrderRow[] {
  const like = `%${likeEscape(q)}%`
  return db
    .prepare(
      `SELECT o.id, o.email, u.name, o.status, o.total, o.review_reason, o.source, o.created_at,
         (SELECT coalesce(sum(amount), 0) FROM payments WHERE order_id = o.id AND kind = 'charge' AND status = 'succeeded') AS paid,
         (SELECT coalesce(sum(amount), 0) FROM payments WHERE order_id = o.id AND kind = 'refund' AND status = 'succeeded') AS refunded
       FROM orders o LEFT JOIN users u ON u.id = o.user_id
       WHERE o.event_id = ? AND (? = '' OR o.status = ?) AND (? = '' OR o.id = ? OR o.email LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\') ORDER BY o.id DESC LIMIT 50`,
    )
    .all(eventId, status, status, q, /^\d+$/.test(q) ? Number(q) : 0, like, like) as OrderRow[]
}

export type Target = { section: string; row: string; number: number | null }

// An inventory row of the event by section name + row + seat number (reserved) or section name alone (GA: first free slot).
// Free now; when comping, also seats the organizer blocked for comps.
function findSeat(eventId: number, t: Target, comp: boolean): number | undefined {
  const free = `(i.status = 'available' OR (i.status = 'held' AND i.held_until < ?)${comp ? " OR (i.status = 'blocked' AND i.block_kind = 'comp')" : ''})`
  const reserved = !!t.row
  const r = db
    .prepare(
      `SELECT i.id FROM inventory i JOIN sections s ON s.id = i.section_id LEFT JOIN seats st ON st.id = i.seat_id
       WHERE i.event_id = ? AND s.name = ? AND ${free} AND ${reserved ? 'st.row = ? AND st.number = ?' : 'i.seat_id IS NULL'} ORDER BY i.slot, i.id LIMIT 1`,
    )
    .get(eventId, t.section, new Date().toISOString(), ...(reserved ? [t.row, t.number ?? 0] : [])) as { id: number } | undefined
  return r?.id
}
const take = (id: number) =>
  db.prepare("UPDATE inventory SET status = 'sold', hold_id = NULL, held_until = NULL, block_kind = NULL WHERE id = ? AND (status IN ('available','blocked') OR (status = 'held' AND held_until < ?))").run(id, new Date().toISOString()).changes === 1

// Move a valid ticket to another seat of the same event, in one tx: the new seat is claimed first (so a lost race changes nothing), then the old
// ticket is cancelled and its seat freed, and a NEW ticket with a NEW secret is issued, so the old QR is dead. The order item follows the seat.
// No price is charged or refunded: it is the organizer's call (a move to a pricier level is an upgrade).
export function moveSeat(orderId: number, ticketId: number, to: Target): number {
  return tx(() => {
    const t = db
      .prepare(
        `SELECT t.status, t.owner_id, t.inventory_id, o.event_id, o.status AS ostatus, o.email, i.event_id AS ievent FROM tickets t JOIN orders o ON o.id = t.order_id
         JOIN inventory i ON i.id = t.inventory_id WHERE t.id = ? AND t.order_id = ?`,
      )
      .get(ticketId, orderId) as { status: string; owner_id: number | null; inventory_id: number; event_id: number; ostatus: string; email: string; ievent: number } | undefined
    if (!t) throw new UserError('Ticket not found on this order')
    if (t.status !== 'valid') throw new UserError(`A ${t.status} ticket cannot be moved`)
    if (!['paid', 'partially_refunded'].includes(t.ostatus)) throw new UserError(`An order that is ${t.ostatus} cannot be changed`)
    const seat = findSeat(t.ievent, to, false)
    if (!seat || !take(seat)) throw new UserError('That seat is not available')
    killTicket(ticketId, true)
    db.prepare('UPDATE order_items SET inventory_id = ? WHERE order_id = ? AND inventory_id = ? AND kind = \'ticket\'').run(seat, orderId, t.inventory_id)
    const id = Number(db.prepare('INSERT INTO tickets (order_id, inventory_id, owner_id, secret) VALUES (?,?,?,?)').run(orderId, seat, t.owner_id, randomBytes(32).toString('hex')).lastInsertRowid)
    const msg = `Your seat for order #${orderId} was changed by the organizer. Your old QR code no longer works; open your new ticket.`
    sendEmail(t.email, `Your seat changed (order #${orderId})`, `${msg}\n${APP_URL}/orders/${orderId}`)
    if (t.owner_id) notify(t.owner_id, 'order', 'Your seat changed', msg, `/tickets/${id}`)
    return id
  })
}

// Complimentary tickets: a paid-for-nothing order ($0, source 'comp') made straight from inventory (free seats or seats the organizer blocked for comps).
// Comps do NOT count toward the per-account ticket limit (they are an allocation, not a purchase), so a comped guest can still buy.
export function compTickets(eventId: number, email: string, seats: Target[], note: string): number {
  email = email.trim().toLowerCase()
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new UserError('Enter a valid email')
  if (!seats.length || seats.length > 8) throw new UserError('Comp 1 to 8 seats at a time')
  return tx(() => {
    const ev = db.prepare('SELECT title, status FROM events WHERE id = ?').get(eventId) as { title: string; status: string }
    if (!['published', 'rescheduled', 'postponed'].includes(ev.status)) throw new UserError('Only published events can be comped')
    const user = db.prepare("SELECT id FROM users WHERE email = ? AND status = 'active'").get(email) as { id: number } | undefined
    const hold = Number(db.prepare("INSERT INTO holds (session_token, user_id, event_id, expires_at, status) VALUES ('comp', ?, ?, ?, 'converted')").run(user?.id ?? null, eventId, new Date().toISOString()).lastInsertRowid)
    const token = randomBytes(16).toString('hex')
    const order = db
      .prepare("INSERT INTO orders (user_id, session_token, access_token, email, event_id, hold_id, status, subtotal, fees, tax, total, source, idempotency_key) VALUES (?, 'comp', ?,?,?,?, 'paid', 0,0,0,0, 'comp', ?) RETURNING id")
      .get(user?.id ?? null, token, email, eventId, hold, `comp-${randomBytes(8).toString('hex')}`) as { id: number }
    for (const s of seats) {
      const seat = findSeat(eventId, s, true)
      if (!seat || !take(seat)) throw new UserError(`${s.section}${s.row ? ` ${s.row}${s.number}` : ''} is not available`)
      db.prepare("INSERT INTO order_items (order_id, kind, inventory_id, unit_cents) VALUES (?, 'ticket', ?, 0)").run(order.id, seat)
      db.prepare('INSERT INTO tickets (order_id, inventory_id, owner_id, secret) VALUES (?,?,?,?)').run(order.id, seat, user?.id ?? null, randomBytes(32).toString('hex'))
    }
    sendEmail(email, `Your complimentary tickets for ${ev.title}`, `You have ${seats.length} complimentary ticket(s) for ${ev.title}.${note ? `\n${note}` : ''}\n${APP_URL}/orders/${order.id}?t=${token}`)
    if (user) notify(user.id, 'order', `Complimentary tickets for ${ev.title}`, '', `/orders/${order.id}`)
    return order.id
  })
}

export type Line = { item_id: number; kind: string; label: string; status: string | null; value: number; refunded_cents: number }

// Refundable items of an order (tickets and add-ons) with the state of their ticket, for the refund form.
export function orderLines(orderId: number): Line[] {
  return db
    .prepare(
      `SELECT oi.id AS item_id, oi.kind, oi.unit_cents + oi.fee_cents + oi.tax_cents AS value, oi.refunded_cents,
         CASE WHEN oi.kind = 'addon' THEN a.name WHEN st.row IS NOT NULL THEN 'Section ' || s.name || ' Row ' || st.row || ' Seat ' || st.number ELSE 'General admission ' || s.name END AS label,
         (SELECT status FROM tickets WHERE order_id = oi.order_id AND (inventory_id = oi.inventory_id OR addon_id = oi.addon_id) ORDER BY id DESC LIMIT 1) AS status
       FROM order_items oi LEFT JOIN inventory i ON i.id = oi.inventory_id LEFT JOIN sections s ON s.id = i.section_id LEFT JOIN seats st ON st.id = i.seat_id LEFT JOIN addons a ON a.id = oi.addon_id
       WHERE oi.order_id = ? AND oi.kind IN ('ticket','addon') ORDER BY oi.id`,
    )
    .all(orderId) as Line[]
}

// The refund form: full (everything left), items (the ticked ones, with or without fees and tax), or void (cancel, no money back).
// Strict: if the card refuses, nothing changes and the UserError says so.
export function refundFromForm(orderId: number, mode: string, items: number[], fees: boolean, reason: string) {
  if (mode === 'void') return refundOrder(orderId, { reason, refund: false })
  if (mode === 'items') {
    if (!items.length) throw new UserError('Tick at least one item')
    return refundOrder(orderId, { reason, items, fees })
  }
  return refundOrder(orderId, { reason })
}
