import { db } from './db.ts'
import { prefsOf } from './account.ts'
import { emailUser } from './alerts.ts'
import { hit } from './defense.ts'
import { UserError } from './platform.ts'

export const MAX_RECIPIENTS = 500
export const MAX_PER_DAY = 3

// The fan list of an event: followers of the event, its artists or its venue, plus buyers with a live order. Registered, active users only.
// Opted-in = their own "News and offers" email preference is on (default off).
export function fanList(eventId: number): { id: number; email: string; optedIn: boolean }[] {
  const rows = db
    .prepare(
      `SELECT u.id, u.email, u.notif_prefs FROM users u WHERE u.status = 'active' AND u.id IN (
         SELECT f.user_id FROM favorites f JOIN events e ON e.id = ? WHERE (f.kind = 'event' AND f.ref_id = e.id) OR (f.kind = 'venue' AND f.ref_id = e.venue_id)
            OR (f.kind = 'artist' AND f.ref_id IN (SELECT artist_id FROM event_artists WHERE event_id = e.id))
         UNION SELECT user_id FROM orders WHERE event_id = ? AND user_id IS NOT NULL AND status IN ('paid','partially_refunded')) ORDER BY u.id`,
    )
    .all(eventId, eventId) as { id: number; email: string; notif_prefs: string | null }[]
  return rows.map((r) => ({ id: r.id, email: r.email, optedIn: !!prefsOf(r.notif_prefs).marketing_email }))
}

// Send a marketing email to the opted-in fan list. Limits: 3 campaigns per event per day, 500 recipients, subject 120 / body 2000 characters.
// Every mail goes through emailUser (preference check + unsubscribe footer). The caller audits.
export function sendCampaign(eventId: number, subject: string, body: string): { sent: number; skipped: number } {
  subject = subject.trim()
  body = body.trim()
  if (!subject || subject.length > 120) throw new UserError('Subject required (120 characters max)')
  if (!body || body.length > 2000) throw new UserError('Message required (2000 characters max)')
  const list = fanList(eventId)
  const optedIn = list.filter((f) => f.optedIn)
  if (optedIn.length > MAX_RECIPIENTS) throw new UserError(`This fan list has ${optedIn.length} opted-in fans; the limit is ${MAX_RECIPIENTS} per campaign`)
  if (!hit(`campaign:event:${eventId}`, MAX_PER_DAY, 86_400_000)) throw new UserError(`At most ${MAX_PER_DAY} campaigns per event per day`)
  let sent = 0
  for (const f of optedIn) if (emailUser(f.id, 'marketing', f.email, subject, body)) sent++
  return { sent, skipped: list.length - sent }
}
