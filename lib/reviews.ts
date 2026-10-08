import { db } from './db.ts'
import { UserError } from './platform.ts'

export type Target = 'event' | 'venue'

// Verified attendee = owns a ticket for the event (or for any event at the venue) that was SCANNED at the door. Everything else is refused server-side.
export function attended(userId: number, kind: Target, refId: number): boolean {
  const join = kind === 'event' ? 'i.event_id = ?' : 'i.event_id IN (SELECT id FROM events WHERE venue_id = ?)'
  return !!db.prepare(`SELECT 1 FROM tickets t JOIN inventory i ON i.id = t.inventory_id WHERE t.owner_id = ? AND t.status = 'used' AND ${join} LIMIT 1`).get(userId, refId)
}

export function submitReview(userId: number, kind: Target, refId: number, rating: number, body: string): number {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new UserError('Choose 1 to 5 stars')
  if (!body || body.length > 1000) throw new UserError('Write a review of up to 1000 characters')
  const exists = db.prepare(kind === 'event' ? 'SELECT 1 FROM events WHERE id = ?' : 'SELECT 1 FROM venues WHERE id = ?').get(refId)
  if (!exists) throw new UserError('Nothing to review here')
  if (!attended(userId, kind, refId)) throw new UserError('Only people who attended can review: you need a ticket that was scanned at the door')
  try {
    return Number(db.prepare(`INSERT INTO reviews (user_id, ${kind}_id, rating, body) VALUES (?,?,?,?)`).run(userId, refId, rating, body).lastInsertRowid)
  } catch (e) {
    if (/UNIQUE/.test(String(e))) throw new UserError(`You already reviewed this ${kind}`)
    throw e
  }
}

export function decideReview(adminId: number, id: number, approve: boolean) {
  const r = db.prepare("UPDATE reviews SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(approve ? 'approved' : 'rejected', adminId, new Date().toISOString(), id)
  if (r.changes !== 1) throw new UserError('Review not found or already decided')
}

export type PublicReview = { rating: number; body: string; created_at: string }
// Approved reviews only; no author identity beyond "verified attendee".
export function approvedReviews(kind: Target, refId: number): { list: PublicReview[]; avg: number | null } {
  const list = db.prepare(`SELECT rating, body, created_at FROM reviews WHERE ${kind}_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 20`).all(refId).map((r) => ({ ...r })) as PublicReview[]
  const a = db.prepare(`SELECT avg(rating) AS a FROM reviews WHERE ${kind}_id = ? AND status = 'approved'`).get(refId) as { a: number | null }
  return { list, avg: a.a }
}
