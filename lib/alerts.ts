import { timingSafeEqual } from 'node:crypto'
import { db, tx } from './db.ts'
import { prefsOf, PREF_CATEGORIES, PREF_LABELS } from './account.ts'
import type { Prefs } from './account.ts'
import { mac } from './defense.ts'
import { fmtDateTime, money } from './format.ts'
import { haversineKm, miToKm } from './geo.ts'
import { APP_URL, notify, sendEmail, sendSms } from './notify.ts'
import { priceTargetAlerts } from './pricealerts.ts'

// ---- unsubscribe tokens: `userId.category.HMAC(userId:category)`, no expiry, one category per token ----
const sign = (userId: number, category: string) => mac(`unsub:${userId}:${category}`).toString('hex')
export const unsubToken = (userId: number, category: string) => `${userId}.${category}.${sign(userId, category)}`

export function verifyUnsub(token: string): { userId: number; category: string } | undefined {
  const m = /^(\d{1,12})\.([a-z]{1,20})\.([0-9a-f]{64})$/.exec(token)
  if (!m || !PREF_CATEGORIES.includes(m[2])) return undefined
  const want = Buffer.from(sign(Number(m[1]), m[2]), 'hex')
  const got = Buffer.from(m[3], 'hex')
  return got.length === want.length && timingSafeEqual(got, want) ? { userId: Number(m[1]), category: m[2] } : undefined
}

const footer = (userId: number, category: string) =>
  `\n\n--\nYou get this because of your ${PREF_LABELS[category].toLowerCase()} settings. Unsubscribe from these emails: ${APP_URL}/unsubscribe?t=${unsubToken(userId, category)}`

// Turn one email category off for a user (what the unsubscribe link does). Other preferences are kept.
export function unsubscribe(userId: number, category: string) {
  const u = db.prepare('SELECT notif_prefs FROM users WHERE id = ?').get(userId) as { notif_prefs: string | null } | undefined
  if (!u) return
  db.prepare('UPDATE users SET notif_prefs = ? WHERE id = ?').run(JSON.stringify({ ...prefsOf(u.notif_prefs), [`${category}_email`]: false }), userId)
}

const prefsFor = (userId: number): Prefs => prefsOf((db.prepare('SELECT notif_prefs FROM users WHERE id = ?').get(userId) as { notif_prefs: string | null }).notif_prefs)

// Optional email (alerts, marketing) to a registered user: respects that user's preference for the category and carries the unsubscribe link.
// Essential mail (orders, tickets, transfers, event changes) uses sendEmail directly: always sent, no footer.
export function emailUser(userId: number, category: string, to: string, subject: string, body: string): boolean {
  if (!prefsFor(userId)[`${category}_email`]) return false
  sendEmail(to, subject, body + footer(userId, category))
  return true
}

type Msg = { title: string; body?: string; link: string }
// Send one alert over the user's channels (in-app inbox, email, SMS, each per category). Idempotent: (user, kind, ref) is recorded first,
// and an alert already recorded is never sent again. Returns whether it was sent now. `email: false` when the caller already mailed it.
export function alertUser(userId: number, category: string, kind: string, ref: string, m: Msg, o: { email?: boolean } = {}): boolean {
  const u = db.prepare("SELECT email, phone FROM users WHERE id = ? AND status = 'active'").get(userId) as { email: string; phone: string | null } | undefined
  if (!u || db.prepare('INSERT OR IGNORE INTO alerts_sent (user_id, kind, ref) VALUES (?,?,?)').run(userId, kind, ref).changes !== 1) return false
  const p = prefsFor(userId)
  const essential = category === 'orders' // no preference: inbox always, mail without footer, no SMS
  if (essential || p[`${category}_inapp`]) notify(userId, kind, m.title, m.body ?? '', m.link)
  const text = `${m.body ?? m.title}\n${APP_URL}${m.link}`
  if (o.email !== false) {
    if (essential) sendEmail(u.email, m.title, text)
    else emailUser(userId, category, u.email, m.title, text)
  }
  if (!essential && p[`${category}_sms`] && u.phone) sendSms(u.phone, `TicketStorm: ${m.title} ${APP_URL}${m.link}`)
  return true
}

// ---- jobs ----
type Fan = { user_id: number; event_id: number; title: string; slug: string; starts_at: string; tz: string; venue: string; onsale_at: string | null; direct: number; vlat: number; vlng: number; hlat: number | null; hlng: number | null; radius: number }

// Fans of upcoming public events, one aggregate query (no per-event or per-user lookups): `branches` picks what they follow
// (the event itself, its venue, one of its artists). Rows whose alert was already recorded are filtered out in SQL.
function fans(kind: string, branches: ('event' | 'venue' | 'artist')[], where: string, args: (string | number)[]): Fan[] {
  const join = {
    event: "JOIN favorites f ON f.kind = 'event' AND f.ref_id = e.id",
    venue: "JOIN favorites f ON f.kind = 'venue' AND f.ref_id = e.venue_id",
    artist: "JOIN event_artists ea ON ea.event_id = e.id JOIN favorites f ON f.kind = 'artist' AND f.ref_id = ea.artist_id",
  }
  const sql = branches
    .map(
      (b) => `SELECT f.user_id, e.id AS event_id, e.title, e.slug, e.starts_at, v.tz, v.name AS venue, e.onsale_at, ${b === 'event' ? 1 : 0} AS direct,
         v.lat AS vlat, v.lng AS vlng, c.lat AS hlat, c.lng AS hlng, u.alert_radius_mi AS radius
       FROM events e JOIN venues v ON v.id = e.venue_id ${join[b]} JOIN users u ON u.id = f.user_id AND u.status = 'active' LEFT JOIN cities c ON c.id = u.home_city_id
       WHERE e.status = 'published' AND e.approved = 1 AND e.starts_at > ? AND ${where}
         AND NOT EXISTS (SELECT 1 FROM alerts_sent a WHERE a.user_id = f.user_id AND a.kind = '${kind}' AND a.ref = 'event:' || e.id)`,
    )
    .join(' UNION ')
  const now = new Date().toISOString()
  return db.prepare(sql).all(...branches.flatMap(() => [now, ...args])) as Fan[]
}

// Followed artists/venues only count inside the user's radius. No home city = no way to measure, so they are not filtered.
const inRadius = (f: Fan) => f.direct === 1 || f.hlat === null || haversineKm(f.hlat, f.hlng!, f.vlat, f.vlng) <= miToKm(f.radius)

function newEvents() {
  for (const f of fans('new_event', ['venue', 'artist'], 'coalesce(e.published_at, e.created_at) > f.created_at', []).filter(inRadius)) {
    alertUser(f.user_id, 'alerts', 'new_event', `event:${f.event_id}`, {
      title: `New show: ${f.title}`,
      body: `${f.title} at ${f.venue} on ${fmtDateTime(f.starts_at, f.tz)}.`,
      link: `/events/${f.slug}`,
    })
  }
}

// ponytail: reminders only fire if the jobs run inside the hour before on-sale (the layout runs them at most every 30s while anyone browses; `npm run jobs` otherwise). A cron every few minutes would make it dependable.
// Tickets go on sale within the next hour, for fans of the event, its venue or one of its artists.
function onsaleSoon(now: number) {
  const soon = fans('onsale_soon', ['event', 'venue', 'artist'], 'e.onsale_at > ? AND e.onsale_at <= ?', [new Date(now).toISOString(), new Date(now + 3_600_000).toISOString()])
  for (const f of soon.filter(inRadius)) {
    alertUser(f.user_id, 'alerts', 'onsale_soon', `event:${f.event_id}`, {
      title: `On sale soon: ${f.title}`,
      body: `Tickets for ${f.title} go on sale at ${fmtDateTime(f.onsale_at!, f.tz)}.`,
      link: `/events/${f.slug}`,
    })
  }
}

// Watched event = favorited event. favorites.last_price is the cheapest face price when we last looked; a lower price now is a drop.
// (Base face of the cheapest non-bundle level; dynamic surcharges and the all-in toggle are not part of this comparison.)
function priceDrops() {
  const rows = db
    .prepare(
      `SELECT f.user_id, f.ref_id AS event_id, e.title, e.slug, f.last_price,
         (SELECT min(price_cents) FROM price_levels WHERE event_id = e.id AND event_ids IS NULL) AS cur
       FROM favorites f JOIN events e ON e.id = f.ref_id JOIN users u ON u.id = f.user_id AND u.status = 'active'
       WHERE f.kind = 'event' AND e.status IN ('published','rescheduled') AND e.approved = 1 AND e.starts_at > ?`,
    )
    .all(new Date().toISOString()) as { user_id: number; event_id: number; title: string; slug: string; last_price: number | null; cur: number | null }[]
  const set = db.prepare("UPDATE favorites SET last_price = ? WHERE user_id = ? AND kind = 'event' AND ref_id = ?")
  for (const r of rows) {
    if (r.cur === null || r.cur === r.last_price) continue
    if (r.last_price !== null && r.cur < r.last_price) {
      alertUser(r.user_id, 'alerts', 'price_drop', `event:${r.event_id}:${r.cur}`, {
        title: `Price drop: ${r.title}`,
        body: `Tickets now start at ${money(r.cur)}, down from ${money(r.last_price)}.`,
        link: `/events/${r.slug}`,
      })
    }
    set.run(r.cur, r.user_id, r.event_id)
  }
}

export function runAlerts(now = Date.now()) {
  tx(() => {
    newEvents()
    onsaleSoon(now)
    priceDrops()
    priceTargetAlerts()
  })
}
