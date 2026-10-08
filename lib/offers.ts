import { db, tx } from './db.ts'
import { alertUser } from './alerts.ts'
import { money } from './format.ts'
import { HoldError } from './inventory.ts'
import { priceBounds } from './resale.ts'
import { resaleRule } from './rules.ts'
import { balance } from './ledger.ts'

export const OFFER_HOURS = 48 // an unanswered offer lapses
export const RESERVE_MINUTES = 30 // an accepted offer reserves the listing for the buyer this long

type Row = { id: number; listing_id: number; buyer_id: number; price_cents: number; status: string; expires_at: string }
const iso = (ms = Date.now()) => new Date(ms).toISOString()

// A buyer offers less than the asking price. Floor and ceiling of the event's resale rule apply; one pending offer per buyer per listing.
export function makeOffer(buyerId: number, listingId: number, cents: number): number {
  if (!Number.isSafeInteger(cents) || cents < 1) throw new HoldError('Enter an offer above $0', 400)
  return tx(() => {
    const now = iso()
    const l = db
      .prepare(
        `SELECT l.seller_id, l.price_cents, l.ticket_id, i.event_id, e.non_transferable, e.title FROM listings l JOIN tickets t ON t.id = l.ticket_id JOIN inventory i ON i.id = t.inventory_id
         JOIN events e ON e.id = i.event_id WHERE l.id = ? AND l.status = 'active' AND l.expires_at > ? AND t.status = 'listed'`,
      )
      .get(listingId, now) as { seller_id: number; price_cents: number; ticket_id: number; event_id: number; non_transferable: number; title: string } | undefined
    if (!l) throw new HoldError('Listing not found', 404)
    if (l.seller_id === buyerId) throw new HoldError("You can't make an offer on your own listing", 403)
    if (l.non_transferable || !resaleRule(l.event_id).enabled) throw new HoldError('Resale is turned off for this event')
    if (cents >= l.price_cents) throw new HoldError(`An offer must be below the asking price (${money(l.price_cents)}); buy it at that price instead`, 400)
    const b = priceBounds(l.ticket_id, l.event_id)
    if (cents < b.min) throw new HoldError(`For this event offers must be at least ${money(b.min)} (${b.rule.min_pct}% of face value)`, 400)
    let id: number
    try {
      id = Number(db.prepare('INSERT INTO resale_offers (listing_id, buyer_id, price_cents, expires_at) VALUES (?,?,?,?)').run(listingId, buyerId, cents, iso(Date.now() + OFFER_HOURS * 3_600_000)).lastInsertRowid)
    } catch (e) {
      if (/UNIQUE/.test(String(e))) throw new HoldError('You already have a pending offer on this listing: withdraw it first', 409)
      throw e
    }
    alertUser(l.seller_id, 'orders', 'offer_received', `offer:${id}`, { title: 'New offer on your ticket', body: `${money(cents)} offered for ${l.title} (asking ${money(l.price_cents)}). Accept or reject it on your seller dashboard.`, link: '/seller' })
    return id
  })
}

export function withdrawOffer(buyerId: number, offerId: number) {
  const r = db.prepare("UPDATE resale_offers SET status = 'withdrawn', decided_at = ? WHERE id = ? AND buyer_id = ? AND status = 'pending'").run(iso(), offerId, buyerId)
  if (r.changes !== 1) throw new HoldError('Offer not found or already answered', 404)
}

export function rejectOffer(sellerId: number, offerId: number) {
  tx(() => {
    const o = db
      .prepare("UPDATE resale_offers SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending' AND listing_id IN (SELECT id FROM listings WHERE seller_id = ?) RETURNING buyer_id, price_cents")
      .get(iso(), offerId, sellerId) as { buyer_id: number; price_cents: number } | undefined
    if (!o) throw new HoldError('Offer not found or already answered', 404)
    alertUser(o.buyer_id, 'orders', 'offer_rejected', `offer:${offerId}`, { title: 'Your offer was declined', body: `The seller declined your offer of ${money(o.price_cents)}. You can still buy at the asking price.`, link: '/seller' })
  })
}

// Accepting reserves the listing for the buyer at the offer price for RESERVE_MINUTES. ONE conditional UPDATE on the listing (active, nobody checking
// out, nothing already reserved) decides the winner, so two offers can never both be accepted; the loser gets a 409. Other pending offers are declined.
export function acceptOffer(sellerId: number, offerId: number) {
  tx(() => {
    const now = iso()
    const o = db.prepare('SELECT * FROM resale_offers WHERE id = ?').get(offerId) as Row | undefined
    if (!o || o.status !== 'pending') throw new HoldError('Offer not found or already answered', 404)
    if (o.expires_at <= now) throw new HoldError('This offer has expired', 409)
    const until = iso(Date.now() + RESERVE_MINUTES * 60_000)
    const r = db
      .prepare(
        `UPDATE listings SET reserved_for = ?, reserved_until = ?, offer_price_cents = ?
         WHERE id = ? AND seller_id = ? AND status = 'active' AND expires_at > ? AND (hold_id IS NULL OR held_until < ?) AND (reserved_until IS NULL OR reserved_until < ?)`,
      )
      .run(o.buyer_id, until, o.price_cents, o.listing_id, sellerId, now, now, now)
    if (r.changes !== 1) throw new HoldError('This listing is no longer open: another offer was accepted, a buyer is checking out, or it was sold', 409)
    db.prepare("UPDATE resale_offers SET status = 'accepted', decided_at = ? WHERE id = ? AND status = 'pending'").run(now, offerId)
    for (const x of db.prepare("UPDATE resale_offers SET status = 'rejected', decided_at = ? WHERE listing_id = ? AND status = 'pending' RETURNING id, buyer_id").all(now, o.listing_id) as { id: number; buyer_id: number }[]) {
      alertUser(x.buyer_id, 'orders', 'offer_rejected', `offer:${x.id}`, { title: 'Your offer was declined', body: 'The seller accepted another offer.', link: '/seller' })
    }
    alertUser(o.buyer_id, 'orders', 'offer_accepted', `offer:${offerId}`, { title: 'Your offer was accepted', body: `The seller accepted ${money(o.price_cents)}. The ticket is reserved for you for ${RESERVE_MINUTES} minutes: check out from your seller dashboard.`, link: '/seller' })
  })
}

export type SellerView = {
  listings: { id: number; price_cents: number; seller_fee_pct: number; title: string; reserved: number }[]
  received: { id: number; listing_id: number; price_cents: number; ask: number; title: string; expires_at: string }[]
  made: { id: number; listing_id: number; price_cents: number; ask: number; title: string; status: string; reserved_until: string | null }[]
  sold: { id: number; title: string; price_cents: number; net: number }[]
  net: number
  balance: number
}

// Everything the seller dashboard shows. Offers whose listing is gone or whose time ran out are 'closed'.
export function sellerView(userId: number): SellerView {
  const now = iso()
  const q = <T>(sql: string, ...a: (string | number)[]) => db.prepare(sql).all(...a).map((r) => ({ ...r })) as T[]
  const base = 'FROM listings l JOIN tickets t ON t.id = l.ticket_id JOIN inventory i ON i.id = t.inventory_id JOIN events e ON e.id = i.event_id'
  const sold = q<{ id: number; title: string; price_cents: number; net: number }>(
    `SELECT l.id, e.title, l.price_cents, coalesce((SELECT sum(amount) FROM ledger WHERE ref = 'listing:' || l.id AND account = 'user:' || l.seller_id AND kind = 'resale_credit'), 0) AS net ${base} WHERE l.seller_id = ? AND l.status = 'sold' ORDER BY l.id DESC`, userId)
  return {
    listings: q(`SELECT l.id, l.price_cents, l.seller_fee_pct, e.title, coalesce(l.reserved_until > '${now}', 0) AS reserved ${base} WHERE l.seller_id = ? AND l.status = 'active' ORDER BY l.id DESC`, userId),
    received: q(`SELECT o.id, o.listing_id, o.price_cents, l.price_cents AS ask, e.title, o.expires_at FROM resale_offers o JOIN listings l ON l.id = o.listing_id JOIN tickets t ON t.id = l.ticket_id
      JOIN inventory i ON i.id = t.inventory_id JOIN events e ON e.id = i.event_id WHERE l.seller_id = ? AND o.status = 'pending' AND o.expires_at > ? AND l.status = 'active' ORDER BY o.id DESC`, userId, now),
    made: q(`SELECT o.id, o.listing_id, o.price_cents, l.price_cents AS ask, e.title, l.reserved_until,
        CASE WHEN o.status = 'pending' AND (o.expires_at <= ? OR l.status != 'active') THEN 'closed'
             WHEN o.status = 'accepted' AND (l.status != 'active' OR l.reserved_until IS NULL OR l.reserved_until <= ? OR l.reserved_for IS NOT o.buyer_id) THEN 'closed' ELSE o.status END AS status
      FROM resale_offers o JOIN listings l ON l.id = o.listing_id JOIN tickets t ON t.id = l.ticket_id JOIN inventory i ON i.id = t.inventory_id JOIN events e ON e.id = i.event_id
      WHERE o.buyer_id = ? ORDER BY o.id DESC LIMIT 30`, now, now, userId),
    sold, net: sold.reduce((n, s) => n + s.net, 0), balance: balance(`user:${userId}`),
  }
}

// The buyer's way into checkout after an accepted offer: holds the reserved listing (holdListing keeps the offer price for them).
export function reservedFor(buyerId: number, offerId: number): number {
  const r = db
    .prepare("SELECT o.listing_id FROM resale_offers o JOIN listings l ON l.id = o.listing_id WHERE o.id = ? AND o.buyer_id = ? AND o.status = 'accepted' AND l.reserved_for = o.buyer_id AND l.reserved_until > ? AND l.status = 'active'")
    .get(offerId, buyerId, iso()) as { listing_id: number } | undefined
  if (!r) throw new HoldError('This offer is no longer reserved for you', 409)
  return r.listing_id
}
