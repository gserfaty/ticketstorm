import { db } from './db.ts'
import { UserError } from './platform.ts'
import { alertUser } from './alerts.ts'
import { money } from './format.ts'

// "Tell me when tickets for this event are $X or less." Compared with the cheapest face price (before fees and tax, so the all-in toggle does
// not matter) of the cheapest level that still has a seat to buy. The job notifies at most once per (user, event, target) through alerts_sent; changing the target arms it again.
export function setPriceAlert(userId: number, eventId: number, dollars: string) {
  const m = /^\d{1,5}(\.\d{1,2})?$/.exec(dollars.trim())
  const cents = m ? Math.round(Number(dollars) * 100) : 0
  if (cents < 1) throw new UserError('Enter a target price like 45 or 45.50')
  if (!db.prepare("SELECT 1 FROM events WHERE id = ? AND status IN ('published','rescheduled') AND approved = 1 AND starts_at > ?").get(eventId, new Date().toISOString())) throw new UserError('You can only watch upcoming events')
  db.prepare('INSERT INTO price_alerts (user_id, event_id, target_cents) VALUES (?,?,?) ON CONFLICT(user_id, event_id) DO UPDATE SET target_cents = excluded.target_cents').run(userId, eventId, cents)
}

export const clearPriceAlert = (userId: number, eventId: number) => void db.prepare('DELETE FROM price_alerts WHERE user_id = ? AND event_id = ?').run(userId, eventId)

export function getPriceAlert(userId: number, eventId: number): { target_cents: number; notified: boolean } | undefined {
  const a = db.prepare('SELECT target_cents FROM price_alerts WHERE user_id = ? AND event_id = ?').get(userId, eventId) as { target_cents: number } | undefined
  if (!a) return undefined
  return { target_cents: a.target_cents, notified: !!db.prepare("SELECT 1 FROM alerts_sent WHERE user_id = ? AND kind = 'price_target' AND ref = ?").get(userId, `event:${eventId}:${a.target_cents}`) }
}

// Job (inside runAlerts' transaction). Returns how many were sent now.
export function priceTargetAlerts(): number {
  const rows = db
    .prepare(
      `SELECT a.user_id, a.event_id, a.target_cents, e.title, e.slug, (SELECT min(pl.price_cents) FROM price_levels pl WHERE pl.event_id = e.id AND pl.event_ids IS NULL
         AND EXISTS (SELECT 1 FROM inventory i WHERE i.price_level_id = pl.id AND (i.status = 'available' OR (i.status = 'held' AND i.held_until < ?)))) AS cur
       FROM price_alerts a JOIN events e ON e.id = a.event_id JOIN users u ON u.id = a.user_id AND u.status = 'active'
       WHERE e.status IN ('published','rescheduled') AND e.approved = 1 AND e.starts_at > ?`,
    )
    .all(new Date().toISOString(), new Date().toISOString()) as { user_id: number; event_id: number; target_cents: number; title: string; slug: string; cur: number | null }[]
  let n = 0
  for (const r of rows) {
    if (r.cur === null || r.cur > r.target_cents) continue
    if (alertUser(r.user_id, 'alerts', 'price_target', `event:${r.event_id}:${r.target_cents}`, {
      title: `Price alert: ${r.title}`,
      body: `Tickets are now ${money(r.cur)} or less, at or under your target of ${money(r.target_cents)}.`,
      link: `/events/${r.slug}`,
    })) n++
  }
  return n
}
