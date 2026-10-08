import { db, tx } from './db.ts'
import { eventState } from './events.ts'
import { assertTicketLimit, free, HoldError } from './inventory.ts'
import type { Owner } from './inventory.ts'
import { ledgerAdd } from './ledger.ts'
import { money } from './format.ts'
import { alertUser } from './alerts.ts'
import { resaleRule } from './rules.ts'
import { admittedNow } from './queue.ts'

// The caller's own 'valid' ticket for an event that is still ahead and not cancelled; else HoldError. Shared by transfers and listings.
export function assertTradable(ticketId: number, userId: number) {
  const t = db
    .prepare(
      `SELECT t.status, t.owner_id, i.event_id, e.status AS estatus, e.starts_at, e.non_transferable, o.status AS ostatus FROM tickets t JOIN inventory i ON i.id = t.inventory_id
       JOIN orders o ON o.id = t.order_id JOIN events e ON e.id = i.event_id WHERE t.id = ?`,
    )
    .get(ticketId) as { status: string; owner_id: number | null; event_id: number; estatus: string; starts_at: string; non_transferable: number; ostatus: string } | undefined
  if (!t || t.owner_id !== userId) throw new HoldError('Ticket not found', 404)
  if (t.non_transferable) throw new HoldError('Tickets for this event are non-transferable: they cannot be sent to someone else or resold')
  if (t.ostatus === 'review') throw new HoldError('This order is under review; its tickets cannot be sent or sold yet')
  if (t.status !== 'valid') throw new HoldError(`A ${t.status} ticket cannot be sent or sold`)
  if (t.estatus === 'cancelled' || Date.parse(t.starts_at) <= Date.now()) throw new HoldError('This event is over or cancelled')
  return t
}

// Face = the unit price paid on the original order line of this ticket (a ticket bought through resale inherits the face of the ticket it replaced,
// so relisting cannot ratchet the ceiling up).
export function faceOf(ticketId: number): number {
  const t = db.prepare('SELECT t.order_id, t.inventory_id, o.source, o.hold_id FROM tickets t JOIN orders o ON o.id = t.order_id WHERE t.id = ?').get(ticketId) as
    | { order_id: number; inventory_id: number | null; source: string | null; hold_id: number }
    | undefined
  if (!t || !t.inventory_id) return 0
  if (t.source === 'resale') {
    const l = db.prepare("SELECT ticket_id FROM listings WHERE hold_id = ? AND status = 'sold'").get(t.hold_id) as { ticket_id: number } | undefined
    return l ? faceOf(l.ticket_id) : 0
  }
  const i = db.prepare("SELECT unit_cents FROM order_items WHERE order_id = ? AND inventory_id = ? AND kind = 'ticket'").get(t.order_id, t.inventory_id) as { unit_cents: number } | undefined
  return i?.unit_cents ?? 0
}

// Price bounds for a listing of this ticket under the event's resale rule.
export function priceBounds(ticketId: number, eventId: number) {
  const r = resaleRule(eventId)
  const face = faceOf(ticketId)
  return { rule: r, face, min: Math.max(Math.ceil((face * r.min_pct) / 100), 1), max: Math.floor((face * r.max_pct) / 100) }
}

function assertPrice(ticketId: number, eventId: number, priceCents: number) {
  if (!Number.isSafeInteger(priceCents) || priceCents < 1) throw new HoldError('Enter a price above $0', 400)
  const { rule, face, min, max } = priceBounds(ticketId, eventId)
  if (!rule.enabled) throw new HoldError('The organizer has turned off resale for this event')
  if (face <= 0) throw new HoldError('Complimentary tickets cannot be resold')
  if (priceCents < min || priceCents > max) throw new HoldError(`For this event the price must be between ${money(min)} and ${money(max)} (${rule.min_pct}% to ${rule.max_pct}% of face value)`, 400)
}

// valid -> listed + an active listing, in one tx. A ticket with a pending transfer stays 'valid' but is refused here.
export function createListing(userId: number, ticketId: number, priceCents: number): number {
  if (!Number.isSafeInteger(priceCents) || priceCents < 1) throw new HoldError('Enter a price above $0', 400)
  return tx(() => {
    const t = assertTradable(ticketId, userId)
    assertPrice(ticketId, t.event_id, priceCents)
    const r = db
      .prepare(
        `UPDATE tickets SET status = 'listed' WHERE id = ? AND status = 'valid' AND owner_id = ?
         AND NOT EXISTS (SELECT 1 FROM transfers WHERE ticket_id = tickets.id AND status = 'pending' AND expires_at > ?)`,
      )
      .run(ticketId, userId, new Date().toISOString())
    if (r.changes !== 1) throw new HoldError('This ticket has a pending transfer')
    return Number(
      db.prepare('INSERT INTO listings (ticket_id, seller_id, price_cents, expires_at, seller_fee_pct) VALUES (?,?,?,?,?)').run(ticketId, userId, priceCents, t.starts_at, resaleRule(t.event_id).seller_fee_pct).lastInsertRowid,
    )
  })
}

// Change the asking price of an active listing nobody is checking out. One conditional UPDATE.
export function updateListing(userId: number, listingId: number, priceCents: number) {
  tx(() => {
    const l = db.prepare('SELECT l.ticket_id, i.event_id FROM listings l JOIN tickets t ON t.id = l.ticket_id JOIN inventory i ON i.id = t.inventory_id WHERE l.id = ? AND l.seller_id = ?').get(listingId, userId) as { ticket_id: number; event_id: number } | undefined
    if (!l) throw new HoldError('Listing not found', 404)
    assertPrice(l.ticket_id, l.event_id, priceCents)
    const now = new Date().toISOString()
    const r = db
      .prepare("UPDATE listings SET price_cents = ?, seller_fee_pct = ? WHERE id = ? AND seller_id = ? AND status = 'active' AND expires_at > ? AND (hold_id IS NULL OR held_until < ?)")
      .run(priceCents, resaleRule(l.event_id).seller_fee_pct, listingId, userId, now, now)
    if (r.changes !== 1) throw new HoldError('Listing not found, already closed, or a buyer is checking out', 409)
  })
}

// Listings die at event start (also checked lazily everywhere through expires_at). Ticket goes back to 'valid'. Listings a buyer is still checking out are left.
export function expireListings(now = new Date().toISOString()): number {
  return tx(() => {
    const rows = db.prepare("UPDATE listings SET status = 'expired' WHERE status = 'active' AND expires_at <= ? AND (hold_id IS NULL OR held_until < ?) RETURNING ticket_id").all(now, now) as { ticket_id: number }[]
    for (const r of rows) db.prepare("UPDATE tickets SET status = 'valid' WHERE id = ? AND status = 'listed'").run(r.ticket_id)
    return rows.length
  })
}

// listed -> valid. Refused while a buyer is holding the listing.
export function cancelListing(userId: number, listingId: number) {
  tx(() => {
    const l = db
      .prepare("UPDATE listings SET status = 'cancelled' WHERE id = ? AND seller_id = ? AND status = 'active' AND (hold_id IS NULL OR held_until < ?) RETURNING ticket_id")
      .get(listingId, userId, new Date().toISOString()) as { ticket_id: number } | undefined
    if (!l) throw new HoldError('Listing not found, already closed, or a buyer is checking out', 409)
    if (db.prepare("UPDATE tickets SET status = 'valid' WHERE id = ? AND status = 'listed'").run(l.ticket_id).changes !== 1) throw new HoldError('Ticket is not listed', 409)
  })
}

// Reserve one listing for this session: ONE conditional UPDATE (active, unexpired, not held by a live hold), so two buyers can't both hold it.
// Checkout/finalize then treat the hold like any other (lines come from pricing.quote). Expiry is lazy via held_until.
export function holdListing(listingId: number, owner: Owner): { holdId: number; expiresAt: string } {
  return tx(() => {
    const l = db
      .prepare(
        `SELECT l.seller_id, e.id AS event_id, e.status, e.starts_at, e.onsale_at, e.hold_minutes FROM listings l JOIN tickets t ON t.id = l.ticket_id
         JOIN inventory i ON i.id = t.inventory_id JOIN events e ON e.id = i.event_id WHERE l.id = ? AND l.status = 'active' AND t.status = 'listed'`,
      )
      .get(listingId) as { seller_id: number; event_id: number; status: string; starts_at: string; onsale_at: string | null; hold_minutes: number } | undefined
    if (!l) throw new HoldError('Listing not found', 404)
    if (owner.userId === l.seller_id) throw new HoldError("You can't buy your own listing", 403)
    if (!eventState(l).canBuy) throw new HoldError('Tickets are not on sale for this event')
    if (!admittedNow(l.event_id, owner.sessionToken)) throw new HoldError('Join the waiting room to buy tickets for this event', 403)
    assertTicketLimit(owner.userId, l.event_id, 1, owner.sessionToken)
    for (const h of db.prepare("SELECT id FROM holds WHERE session_token = ? AND event_id = ? AND status = 'active'").all(owner.sessionToken, l.event_id) as { id: number }[]) free(h.id)
    const now = new Date()
    const expiresAt = new Date(now.getTime() + l.hold_minutes * 60_000).toISOString()
    const holdId = Number(db.prepare('INSERT INTO holds (session_token, user_id, event_id, expires_at) VALUES (?,?,?,?)').run(owner.sessionToken, owner.userId, l.event_id, expiresAt).lastInsertRowid)
    const r = db
      .prepare(
        `UPDATE listings SET hold_id = ?, held_until = ? WHERE id = ? AND status = 'active' AND expires_at > ? AND (hold_id IS NULL OR held_until < ?)`,
      )
      .run(holdId, expiresAt, listingId, now.toISOString(), now.toISOString())
    if (r.changes !== 1) throw new HoldError('Someone else is buying this listing')
    return { holdId, expiresAt }
  })
}

// Called from orders.createOrder inside finalize's tx, BEFORE the buyer's ticket is inserted:
// listing -> sold, seller ticket -> resold, ledger (zero-sum, ref listing:ID): cash -(price + buyer fee + tax), seller +(price - seller fee),
// platform +seller fee and +buyer fee, tax +tax. `paid` = what the quote charged on top of the price. Throws to roll everything back.
export function settleListing(listingId: number, holdId: number, buyerId: number | null, paid: { fee: number; tax: number }) {
  const l = db
    .prepare("UPDATE listings SET status = 'sold' WHERE id = ? AND status = 'active' AND hold_id = ? AND held_until > ? RETURNING ticket_id, seller_id, price_cents, seller_fee_pct")
    .get(listingId, holdId, new Date().toISOString()) as { ticket_id: number; seller_id: number; price_cents: number; seller_fee_pct: number } | undefined
  if (!l) throw new HoldError('That resale ticket is no longer available', 409)
  if (buyerId === l.seller_id) throw new HoldError("You can't buy your own listing", 403)
  if (db.prepare("UPDATE tickets SET status = 'resold' WHERE id = ? AND status = 'listed' AND owner_id = ?").run(l.ticket_id, l.seller_id).changes !== 1) throw new HoldError('That resale ticket is no longer available', 409)
  const ref = `listing:${listingId}`
  const sellerFee = Math.round((l.price_cents * l.seller_fee_pct) / 100)
  const net = l.price_cents - sellerFee
  ledgerAdd('cash', 'sale', -(l.price_cents + paid.fee + paid.tax), ref)
  ledgerAdd(`user:${l.seller_id}`, 'resale_credit', net, ref)
  ledgerAdd('platform', 'fee', sellerFee, ref)
  ledgerAdd('platform', 'fee', paid.fee, ref)
  ledgerAdd('tax', 'fee', paid.tax, ref)
  alertUser(l.seller_id, 'orders', 'ticket_sold', `listing:${listingId}`, { title: 'Your ticket sold', body: `Your resale ticket sold for ${money(l.price_cents)}. After the ${l.seller_fee_pct}% seller fee, ${money(net)} was added to your balance.`, link: '/account/payouts' })
}

export type Listing = { id: number; ticket_id: number; price_cents: number; section: string; row: string | null; number: number | null; mine: number; held: number }

// Active resale listings for an event (reserved seats and GA). `viewerId` marks the viewer's own.
export function activeListings(eventId: number, viewerId: number | null): Listing[] {
  const now = new Date().toISOString()
  return (
    db
      .prepare(
        `SELECT l.id, l.ticket_id, l.price_cents, s.name AS section, st.row, st.number, l.seller_id = ? AS mine, coalesce(l.held_until > ?, 0) AS held
         FROM listings l JOIN tickets t ON t.id = l.ticket_id JOIN inventory i ON i.id = t.inventory_id JOIN sections s ON s.id = i.section_id
         LEFT JOIN seats st ON st.id = i.seat_id WHERE i.event_id = ? AND l.status = 'active' AND t.status = 'listed' AND l.expires_at > ? ORDER BY l.price_cents, l.id`,
      )
      .all(viewerId ?? 0, now, eventId, now) as Listing[]
  )
}
