import { db } from './db.ts'
import { haversineKm, miToKm } from './geo.ts'
import { likeEscape, localDate, whenRange } from './format.ts'

export const CATEGORIES = [
  { slug: 'music', name: 'Music' },
  { slug: 'sports', name: 'Sports' },
  { slug: 'arts-theater', name: 'Arts & Theater' },
  { slug: 'family', name: 'Family' },
  { slug: 'comedy', name: 'Comedy' },
  { slug: 'festivals', name: 'Festivals' },
]

export type EventRow = {
  id: number
  slug: string
  title: string
  category: string
  genre: string | null
  starts_at: string
  status: string
  onsale_at: string | null
  image: string | null
  venue: string
  tz: string
  city: string
  state: string
  vlat: number
  vlng: number
}

export type Filters = {
  q?: string
  category?: string
  genre?: string
  city?: number
  radius?: number
  unit: 'mi' | 'km'
  from?: string
  to?: string
  when?: 'today' | 'weekend' | 'month'
  accessible?: boolean
}

type Params = Record<string, string | string[] | undefined>

const SELECT = `SELECT e.id, e.slug, e.title, e.category, e.genre, e.starts_at, e.status, e.onsale_at, e.image,
  v.name AS venue, v.tz, c.name AS city, c.state, v.lat AS vlat, v.lng AS vlng
  FROM events e JOIN venues v ON v.id = e.venue_id JOIN cities c ON c.id = v.city_id`
const VISIBLE = `e.status != 'draft' AND e.approved = 1`

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s + 'T00:00Z').toISOString().slice(0, 10) === s

// Validate URL params; anything malformed is dropped.
export function parseFilters(sp: Params): Filters {
  const one = (k: string) => {
    const v = sp[k]
    return (Array.isArray(v) ? v[0] : v)?.trim() ?? ''
  }
  const f: Filters = { unit: one('unit') === 'km' ? 'km' : 'mi' }
  const q = one('q').slice(0, 100)
  if (q) f.q = q
  if (CATEGORIES.some((c) => c.slug === one('category'))) f.category = one('category')
  if (one('genre')) f.genre = one('genre').slice(0, 50)
  if (/^\d+$/.test(one('city')) && db.prepare('SELECT 1 FROM cities WHERE id = ?').get(Number(one('city')))) f.city = Number(one('city'))
  const radius = Number(one('radius'))
  if (one('radius') && Number.isFinite(radius) && radius > 0 && radius <= 20000) f.radius = radius
  if (isDate(one('from'))) f.from = one('from')
  if (isDate(one('to'))) f.to = one('to')
  const when = one('when')
  if (when === 'today' || when === 'weekend' || when === 'month') f.when = when
  if (one('accessible') === '1') f.accessible = true
  return f
}

export function searchEvents(f: Filters, limit = 60): { rows: EventRow[]; total: number } {
  const where = [VISIBLE, 'e.starts_at > ?']
  const args: (string | number)[] = [new Date().toISOString()]
  if (f.category) { where.push('e.category = ?'); args.push(f.category) }
  if (f.genre) { where.push('e.genre = ?'); args.push(f.genre) }
  if (f.q) {
    const like = `%${likeEscape(f.q)}%`
    where.push(`(e.title LIKE ? ESCAPE '\\' OR v.name LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR EXISTS
      (SELECT 1 FROM event_artists ea JOIN artists a ON a.id = ea.artist_id WHERE ea.event_id = e.id AND a.name LIKE ? ESCAPE '\\'))`)
    args.push(like, like, like, like)
  }
  if (f.city && f.radius === undefined) { where.push('v.city_id = ?'); args.push(f.city) }
  if (f.accessible) where.push('EXISTS (SELECT 1 FROM sections s JOIN seats st ON st.section_id = s.id WHERE s.venue_id = v.id AND st.accessible = 1)')
  let rows = db.prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY e.starts_at`).all(...args) as EventRow[]

  // Radius and venue-local date filters need haversine / Intl, so they run in JS (small result set).
  if (f.city && f.radius !== undefined) {
    const c = db.prepare('SELECT lat, lng FROM cities WHERE id = ?').get(f.city) as { lat: number; lng: number }
    const km = f.unit === 'km' ? f.radius : miToKm(f.radius)
    rows = rows.filter((r) => haversineKm(c.lat, c.lng, r.vlat, r.vlng) <= km)
  }
  if (f.from || f.to || f.when) {
    const nowIso = new Date().toISOString()
    rows = rows.filter((r) => {
      // "today" is the venue's local today, so evening shows aren't dropped after UTC midnight
      const [from, to] = f.from || f.to ? [f.from, f.to] : whenRange(f.when!, localDate(nowIso, r.tz))
      const d = localDate(r.starts_at, r.tz)
      return (!from || d >= from) && (!to || d <= to)
    })
  }
  return { rows: rows.slice(0, limit), total: rows.length }
}

export function trendingEvents(limit: number): EventRow[] {
  return db
    .prepare(`${SELECT} WHERE ${VISIBLE} AND e.status = 'published' AND e.starts_at > ? ORDER BY e.popularity DESC, e.starts_at LIMIT ?`)
    .all(new Date().toISOString(), limit) as EventRow[]
}

// Upcoming events within `miles` of a city centre, soonest first.
export function eventsNear(cityId: number, miles: number, limit: number): EventRow[] {
  const c = db.prepare('SELECT lat, lng FROM cities WHERE id = ?').get(cityId) as { lat: number; lng: number } | undefined
  if (!c) return []
  return (db.prepare(`${SELECT} WHERE ${VISIBLE} AND e.status = 'published' AND e.starts_at > ? ORDER BY e.starts_at`).all(new Date().toISOString()) as EventRow[])
    .filter((r) => haversineKm(c.lat, c.lng, r.vlat, r.vlng) <= miToKm(miles))
    .slice(0, limit)
}

export function eventsByIds(ids: number[]): EventRow[] {
  if (!ids.length) return []
  return db.prepare(`${SELECT} WHERE ${VISIBLE} AND e.id IN (${ids.map(() => '?').join(',')}) ORDER BY e.starts_at`).all(...ids) as EventRow[]
}

export function genresIn(category: string): string[] {
  return (db.prepare('SELECT DISTINCT genre FROM events WHERE category = ? AND genre IS NOT NULL ORDER BY genre').all(category) as { genre: string }[]).map((r) => r.genre)
}

export function getEvent(slug: string) {
  const e = db
    .prepare(`SELECT e.*, v.name AS venue, v.slug AS venue_slug, v.tz, v.address, c.name AS city, c.state
      FROM events e JOIN venues v ON v.id = e.venue_id JOIN cities c ON c.id = v.city_id WHERE e.slug = ? AND ${VISIBLE}`)
    .get(slug) as
    | { id: number; slug: string; title: string; category: string; genre: string | null; starts_at: string; doors_at: string | null; image: string | null
        description: string | null; status: string; onsale_at: string | null; ticket_limit: number; order_limit: number | null; venue: string; venue_slug: string; tz: string
        address: string; city: string; state: string; venue_id: number; queue_enabled: number }
    | undefined
  if (!e) return undefined
  const lineup = db
    .prepare('SELECT a.id, a.name, a.slug FROM event_artists ea JOIN artists a ON a.id = ea.artist_id WHERE ea.event_id = ? ORDER BY ea.billing')
    .all(e.id) as { id: number; name: string; slug: string }[]
  const levels = db
    .prepare('SELECT id, name, color, price_cents, ticket_type FROM price_levels WHERE event_id = ? ORDER BY price_cents')
    .all(e.id) as { id: number; name: string; color: string | null; price_cents: number; ticket_type: string }[]
  return { ...e, lineup, levels }
}

// Most tickets one order (hold) may contain: order_limit, never above the per-event ticket_limit.
export const orderLimit = (e: { ticket_limit: number; order_limit: number | null }) => Math.min(e.order_limit ?? e.ticket_limit, e.ticket_limit)

// Badge shown on cards and the event page. Pass soldOut (see isSoldOut) where it is cheap to know.
export function eventState(e: { status: string; starts_at: string; onsale_at: string | null }, now = Date.now(), soldOut = false) {
  if (e.status === 'cancelled') return { label: 'Cancelled', canBuy: false }
  if (e.status === 'postponed') return { label: 'Postponed', canBuy: false }
  if (Date.parse(e.starts_at) < now) return { label: 'Ended', canBuy: false }
  if (e.onsale_at && Date.parse(e.onsale_at) > now) return { label: 'Upcoming', canBuy: false }
  if (soldOut) return { label: 'Sold out', canBuy: false }
  return { label: e.status === 'rescheduled' ? 'Rescheduled' : 'On sale', canBuy: true }
}

export function suggest(q: string) {
  const like = `%${likeEscape(q)}%`
  const now = new Date().toISOString()
  return {
    artists: db.prepare("SELECT name, slug FROM artists WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 5").all(like),
    events: db
      .prepare(`SELECT title, slug FROM events e WHERE title LIKE ? ESCAPE '\\' AND ${VISIBLE} AND starts_at > ? ORDER BY starts_at LIMIT 5`)
      .all(like, now),
    venues: db.prepare("SELECT name, slug FROM venues WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 5").all(like),
  }
}
