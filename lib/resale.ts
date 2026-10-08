import { db, tx } from './db.ts'
import { eventState } from './events.ts'
import { free, HoldError } from './inventory.ts'
import type { Owner } from './inventory.ts'
import { ledgerAdd } from './ledger.ts'
import { money } from './format.ts'
import { notify } from './notify.ts'

// The caller's own 'valid' ticket for an event that is still ahead and not cancelled; else HoldError. Shared by transfers and listings.
export function assertTradable(ticketId: number, userId: number) {
  const t = db
    .prepare(
      `SELECT t.status, t.owner_id, e.status AS estatus, e.starts_at FROM tickets t JOIN inventory i ON i.id = t.inventory_id
       JOIN events e ON e.id = i.event_id WHERE t.id = ?`,
    )
    .get(ticketId) as { status: string; owner_id: number | null; estatus: string; starts_at: string } | undefined
  if (!t || t.owner_id !== userId) throw new HoldError('Ticket not found', 404)
  if (t.status !== 'valid') throw new HoldError(`A ${t.status} ticket cannot be sent or sold`)
  if (t.estatus === 'cancelled' || Date.parse(t.starts_at) <= Date.now()) throw new HoldError('This event is over or cancelled')
  return t
}

// valid -> listed + an active listing, in one tx. A ticket with a pending transfer stays 'valid' but is refused here.
export function createListing(userId: number, ticketId: number, priceCents: number): number {
  if (!Number.isSafeInteger(priceCents) || priceCents < 1) throw new HoldError('Enter a price above $0', 400)
  return tx(() => {
    const t = assertTradable(ticketId, userId)
    const r = db
      .prepare(
        `UPDATE tickets SET status = 'listed' WHERE id = ? AND status = 'valid' AND owner_id = ?
         AND NOT EXISTS (SELECT 1 FROM transfers WHERE ticket_id = tickets.id AND status = 'pending' AND expires_at > ?)`,
      )
      .run(ticketId, userId, new Date().toISOString())
    if (r.changes !== 1) throw new HoldError('This ticket has a pending transfer')
    return Number(db.prepare('INSERT INTO listings (ticket_id, seller_id, price_cents, expires_at) VALUES (?,?,?,?)').run(ticketId, userId, priceCents, t.starts_at).lastInsertRowid)
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

// ponytail: ticket_limit is not applied to resale buys; P8 enforces it across orders.
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
// listing -> sold, seller ticket -> resold, seller credited the asking price (seller fee arrives with P11). Throws to roll everything back.
export function settleListing(listingId: number, holdId: number, buyerId: number | null) {
  const l = db
    .prepare("UPDATE listings SET status = 'sold' WHERE id = ? AND status = 'active' AND hold_id = ? AND held_until > ? RETURNING ticket_id, seller_id, price_cents")
    .get(listingId, holdId, new Date().toISOString()) as { ticket_id: number; seller_id: number; price_cents: number } | undefined
  if (!l) throw new HoldError('That resale ticket is no longer available', 409)
  if (buyerId === l.seller_id) throw new HoldError("You can't buy your own listing", 403)
  if (db.prepare("UPDATE tickets SET status = 'resold' WHERE id = ? AND status = 'listed' AND owner_id = ?").run(l.ticket_id, l.seller_id).changes !== 1) throw new HoldError('That resale ticket is no longer available', 409)
  ledgerAdd(`user:${l.seller_id}`, 'resale_credit', l.price_cents, `listing:${listingId}`)
  notify(l.seller_id, 'resale', 'Your ticket sold', `Your resale ticket sold for ${money(l.price_cents)}.`, '/listings')
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
