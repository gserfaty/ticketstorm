import { db } from './db.ts'
import { alertUser } from './alerts.ts'
import { fmtDateTime } from './format.ts'
import { recommendedEvents } from './events.ts'

// ISO 8601 week of a date, e.g. 2026-W41 (weeks start on Monday; the year is the week's Thursday's year).
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7))
  const week = Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7)
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

// Weekly digest: up to 5 recommended upcoming events per user. Idempotent per user per ISO week through alerts_sent (user, 'digest', 'week:...'),
// so running the job any number of times sends one. It is a 'marketing' message: alertUser honours the user's marketing in-app / email / SMS
// preferences and adds the unsubscribe footer to the email.
export function runDigest(now = new Date()): number {
  const week = `week:${isoWeek(now)}`
  const users = db
    .prepare(
      `SELECT u.id, u.home_city_id FROM users u WHERE u.status = 'active' AND NOT EXISTS (SELECT 1 FROM alerts_sent a WHERE a.user_id = u.id AND a.kind = 'digest' AND a.ref = ?)`,
    )
    .all(week) as { id: number; home_city_id: number | null }[]
  let sent = 0
  for (const u of users) {
    const picks = recommendedEvents(u.id, u.home_city_id ?? undefined, 5)
    if (!picks.length) continue
    const body = picks.map((e) => `- ${e.title}, ${e.venue} (${fmtDateTime(e.starts_at, e.tz)}) /events/${e.slug}`).join('\n')
    if (alertUser(u.id, 'marketing', 'digest', week, { title: 'Your weekly TicketStorm digest', body: `Picked for you this week:\n${body}`, link: '/' })) sent++
  }
  return sent
}
