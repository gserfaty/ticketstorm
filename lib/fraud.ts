import { randomInt } from 'node:crypto'
import { db } from './db.ts'
import { alertUser } from './alerts.ts'
import { notify } from './notify.ts'

// An order scoring REVIEW_AT or more goes to 'review': its tickets are not scannable, transferable or sellable until an admin approves it.
export const REVIEW_AT = 50
const NEW_DAYS = 7
const HIGH_VALUE = 50_000 // cents

// Rules: new account (or guest) 30, total of $500+ 30, billing city differs from the city on the profile (address, else home city) 20,
// random 3% 50 (FRAUD_RANDOM_PCT, so tests and the seed can switch it off).
export function fraudScore(p: { userId: number | null; billingCity: string; total: number }): { score: number; reasons: string[] } {
  const reasons: string[] = []
  let score = 0
  const add = (n: number, why: string) => ((score += n), reasons.push(why))
  const u = p.userId
    ? (db.prepare('SELECT u.created_at, u.address, c.name AS home FROM users u LEFT JOIN cities c ON c.id = u.home_city_id WHERE u.id = ?').get(p.userId) as { created_at: string; address: string | null; home: string | null } | undefined)
    : undefined
  if (!u || Date.parse(u.created_at) > Date.now() - NEW_DAYS * 86_400_000) add(30, 'new account')
  if (p.total >= HIGH_VALUE) add(30, 'high value')
  const known = (u?.address ? (JSON.parse(u.address) as { city?: string }).city : '') || u?.home
  if (known && known.trim().toLowerCase() !== p.billingCity.trim().toLowerCase()) add(20, 'billing city mismatch')
  if (randomInt(100) < Number(process.env.FRAUD_RANDOM_PCT ?? 3)) add(50, 'random check')
  return { score, reasons }
}

// paid -> review. Listings and pending transfers on its tickets are cancelled so nothing can move while it is held. Call inside tx().
export function holdOrder(orderId: number, reason: string): boolean {
  const o = db.prepare("UPDATE orders SET status = 'review', review_reason = ? WHERE id = ? AND status IN ('paid','partially_refunded') RETURNING user_id, event_id").get(reason, orderId) as { user_id: number | null; event_id: number } | undefined
  if (!o) return false
  const mine = 'ticket_id IN (SELECT id FROM tickets WHERE order_id = ?)'
  const listed = db.prepare(`UPDATE listings SET status = 'cancelled', hold_id = NULL, held_until = NULL WHERE status = 'active' AND ${mine} RETURNING ticket_id`).all(orderId) as { ticket_id: number }[]
  for (const l of listed) db.prepare("UPDATE tickets SET status = 'valid' WHERE id = ? AND status = 'listed'").run(l.ticket_id)
  db.prepare(`UPDATE transfers SET status = 'cancelled' WHERE status = 'pending' AND ${mine}`).run(orderId)
  if (o.user_id) notify(o.user_id, 'order', `Order #${orderId} is under review`, 'Your tickets are on hold until we finish a quick check.', `/orders/${orderId}`)
  return true
}

// review -> paid. `onlyReason` limits it to holds of one kind (an organizer may release its own hold, not a fraud hold). False if nothing changed.
export function approveReview(orderId: number, onlyReason?: string): boolean {
  const o = db.prepare("UPDATE orders SET status = 'paid', review_reason = NULL WHERE id = ? AND status = 'review' AND (? IS NULL OR review_reason = ?) RETURNING user_id").get(orderId, onlyReason ?? null, onlyReason ?? null) as { user_id: number | null } | undefined
  if (o?.user_id) alertUser(o.user_id, 'orders', 'ticket_delivered', `order:${orderId}`, { title: `Order #${orderId} approved: your tickets are ready`, body: 'Your tickets are ready.', link: `/orders/${orderId}` })
  return !!o
}
