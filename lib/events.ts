import { db } from './db.ts'
import { haversineKm, miToKm } from './geo.ts'
import { likeEscape, localDate, whenRange } from './format.ts'
import { feeDefaults, displayRange, shown } from './pricing.ts'

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
  venue_slug: string
  tz: string
  city: string
  state: string
  vlat: number
  vlng: number
  popularity: number
  hl_name: string | null // headliner, for the card's link
  hl_slug: string | null
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
  min?: number // price range in cents, in the units the fan sees (all-in or face)
  max?: number
  venue?: string // venue slug
  resale?: boolean // has verified resale tickets listed
  presale?: boolean // has a presale window that has not ended
  sort?: 'relevance' | 'date' | 'price' | 'distance' | 'popularity'
}

type Params = Record<string, string | string[] | undefined>

const COLS = `SELECT e.id, e.slug, e.title, e.category, e.genre, e.starts_at, e.status, e.onsale_at, e.image, e.popularity,
  v.name AS venue, v.slug AS venue_slug, v.tz, c.name AS city, c.state, v.lat AS vlat, v.lng AS vlng,
  (SELECT a.name FROM event_artists ea JOIN artists a ON a.id = ea.artist_id WHERE ea.event_id = e.id ORDER BY ea.billing LIMIT 1) AS hl_name,
  (SELECT a.slug FROM event_artists ea JOIN artists a ON a.id = ea.artist_id WHERE ea.event_id = e.id ORDER BY ea.billing LIMIT 1) AS hl_slug`
const FROM = 'FROM events e JOIN venues v ON v.id = e.venue_id JOIN cities c ON c.id = v.city_id'
const SELECT = `${COLS} ${FROM}`
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
  for (const k of ['min', 'max'] as const) {
    const dollars = Number(one(k))
    if (one(k) && Number.isFinite(dollars) && dollars >= 0 && dollars <= 100_000) f[k] = Math.round(dollars * 100)
  }
  if (/^[a-z0-9-]{1,80}$/.test(one('venue'))) f.venue = one('venue')
  if (one('resale') === '1') f.resale = true
  if (one('presale') === '1') f.presale = true
  const sort = one('sort')
  if (sort === 'relevance' || sort === 'date' || sort === 'price' || sort === 'distance' || sort === 'popularity') f.sort = sort
  return f
}

type PriceCols = { pmin: number | null; pmax: number | null; dyn: number; fee_rule: string | null; bps: number }

// Aggregates only (subqueries on indexed event_id columns), so one query serves any number of events:
// cheapest / dearest level, whether any level moves with demand, and the fee rule + city tax needed for all-in prices.
const PRICE_COLS = `, (SELECT min(price_cents) FROM price_levels WHERE event_id = e.id) AS pmin, (SELECT max(price_cents) FROM price_levels WHERE event_id = e.id) AS pmax,
  EXISTS (SELECT 1 FROM price_levels WHERE event_id = e.id AND (dyn_k > 0 OR dyn_j > 0)) AS dyn, e.fee_rule, c.tax_rate_bps AS bps`

// `opt.allIn`: the viewer's all-in toggle, so min/max/sort by price mean the prices on the cards. `opt.ref`: city to measure distance from when no city filter is set.
export function searchEvents(f: Filters, limit = 60, opt: { allIn?: boolean; ref?: number } = {}): { rows: EventRow[]; total: number } {
  const now = new Date().toISOString()
  const where = [VISIBLE, 'e.starts_at > ?']
  const args: (string | number)[] = [now]
  if (f.category) { where.push('e.category = ?'); args.push(f.category) }
  if (f.genre) { where.push('e.genre = ?'); args.push(f.genre) }
  if (f.venue) { where.push('v.slug = ?'); args.push(f.venue) }
  const sort = f.sort ?? (f.q ? 'relevance' : 'date')
  let order = 'e.starts_at'
  const orderArgs: string[] = []
  if (f.q) {
    const like = `%${likeEscape(f.q)}%`
    const byArtist = "EXISTS (SELECT 1 FROM event_artists ea JOIN artists a ON a.id = ea.artist_id WHERE ea.event_id = e.id AND a.name LIKE ? ESCAPE '\\')"
    where.push(`(e.title LIKE ? ESCAPE '\\' OR v.name LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR ${byArtist})`)
    args.push(like, like, like, like)
    if (sort === 'relevance') {
      order = `(e.title LIKE ? ESCAPE '\\') * 4 + ${byArtist} * 3 + (v.name LIKE ? ESCAPE '\\') * 2 + (c.name LIKE ? ESCAPE '\\') DESC, e.popularity DESC, e.starts_at`
      orderArgs.push(like, like, like, like)
    }
  }
  if (sort === 'popularity' || (sort === 'relevance' && !f.q)) order = 'e.popularity DESC, e.starts_at'
  if (f.city && f.radius === undefined) { where.push('v.city_id = ?'); args.push(f.city) }
  // accessible = this event still has an accessible seat to buy (the venue merely having some is not enough)
  if (f.accessible) {
    where.push(`EXISTS (SELECT 1 FROM inventory i JOIN seats st ON st.id = i.seat_id WHERE i.event_id = e.id AND st.accessible = 1
      AND (i.status = 'available' OR (i.status = 'held' AND i.held_until < ?)))`)
    args.push(now)
  }
  if (f.resale) {
    where.push(`EXISTS (SELECT 1 FROM listings l JOIN tickets t ON t.id = l.ticket_id JOIN inventory i ON i.id = t.inventory_id
      WHERE l.status = 'active' AND l.expires_at > ? AND t.status = 'listed' AND i.event_id = e.id)`)
    args.push(now)
  }
  if (f.presale) {
    where.push('EXISTS (SELECT 1 FROM onsale_windows w WHERE w.event_id = e.id AND w.ends_at > ?)')
    args.push(now)
  }
  let rows = db.prepare(`${COLS}${PRICE_COLS} ${FROM} WHERE ${where.join(' AND ')} ORDER BY ${order}`).all(...args, ...orderArgs) as (EventRow & PriceCols)[]

  // Radius and venue-local date filters need haversine / Intl, so they run in JS (small result set).
  const refId = f.city ?? opt.ref
  const ref = refId ? (db.prepare('SELECT lat, lng FROM cities WHERE id = ?').get(refId) as { lat: number; lng: number } | undefined) : undefined
  if (f.city && f.radius !== undefined && ref) {
    const km = f.unit === 'km' ? f.radius : miToKm(f.radius)
    rows = rows.filter((r) => haversineKm(ref.lat, ref.lng, r.vlat, r.vlng) <= km)
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
  if (f.min !== undefined || f.max !== undefined || sort === 'price') {
    // [cheapest, dearest] as shown to this viewer; events with demand-priced levels use the same helper as their card
    const defaults = feeDefaults()
    const range = (r: EventRow & PriceCols): [number, number] | null => {
      if (r.pmin === null) return null
      if (r.dyn) return displayRange(r.id, !!opt.allIn)
      const ctx = { rule: { ...defaults, ...(r.fee_rule ? JSON.parse(r.fee_rule) : {}) }, bps: r.bps }
      return [shown(r.pmin, ctx, !!opt.allIn), shown(r.pmax!, ctx, !!opt.allIn)]
    }
    const priced = rows.map((r) => ({ r, p: range(r) }))
    const kept = priced.filter(({ p }) => (f.min === undefined && f.max === undefined) || (p && (f.min === undefined || p[1] >= f.min) && (f.max === undefined || p[0] <= f.max)))
    if (sort === 'price') kept.sort((a, b) => (a.p?.[0] ?? Infinity) - (b.p?.[0] ?? Infinity))
    rows = kept.map((k) => k.r)
  }
  if (sort === 'distance' && ref) {
    const d = (r: EventRow) => haversineKm(ref.lat, ref.lng, r.vlat, r.vlng)
    rows = rows.map((r) => [d(r), r] as const).sort((a, b) => a[0] - b[0]).map((x) => x[1])
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

// Upcoming public events matching an extra condition (venue page, artist page, series).
export function listEvents(cond: string, args: (string | number)[], limit = 50): EventRow[] {
  return db.prepare(`${SELECT} WHERE ${VISIBLE} AND e.starts_at > ? AND ${cond} ORDER BY e.starts_at LIMIT ?`).all(new Date().toISOString(), ...args, limit) as EventRow[]
}

export function allGenres(): string[] {
  return (db.prepare('SELECT DISTINCT genre FROM events WHERE genre IS NOT NULL ORDER BY genre').all() as { genre: string }[]).map((r) => r.genre)
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
        address: string; city: string; state: string; venue_id: number; queue_enabled: number; info: string | null; series_key: string | null }
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

// ---- event page content (events.info JSON) ----
export type EventInfo = { age?: string; bag?: string; notices?: string; set_times?: { act: string; time: string }[] } // time = venue wall clock "HH:MM"
export const eventInfo = (json: string | null): EventInfo => {
  try { return json ? JSON.parse(json) : {} } catch { return {} }
}

// Other upcoming public dates of the same tour/series.
export const otherDates = (e: { id: number; series_key: string | null }) => (e.series_key ? listEvents('e.series_key = ? AND e.id != ?', [e.series_key, e.id], 12) : [])

// ---- recommendations ----
export type Cand = { genre: string | null; popularity: number; artistIds: number[]; vlat: number; vlng: number }
export type Profile = { genres: Map<string, number>; artists: Set<number>; home?: { lat: number; lng: number } }

// Simple rule score, all terms in "points":
//   genre overlap  2 per time the fan favorited / followed / bought that genre (counted up to 3 times)
//   followed artist 6 when an artist on the bill is followed
//   distance decay  4 at the fan's city, halving every 150 km (2 when we don't know where they are)
//   popularity      up to 3 (events.popularity is 0..100)
export function score(c: Cand, p: Profile): number {
  const overlap = Math.min(p.genres.get(c.genre ?? '') ?? 0, 3)
  const followed = c.artistIds.some((a) => p.artists.has(a)) ? 1 : 0
  const decay = p.home ? 0.5 ** (haversineKm(p.home.lat, p.home.lng, c.vlat, c.vlng) / 150) : 0.5
  return 2 * overlap + 6 * followed + 4 * decay + 3 * (c.popularity / 100)
}

// Events for the home-page rail. Guests (userId null) have no history, so it falls back to popularity + distance from `cityId`.
export function recommendedEvents(userId: number | null, cityId: number | undefined, limit: number): EventRow[] {
  const genres = new Map<string, number>()
  const artists = new Set<number>()
  const owned = new Set<number>()
  let home = cityId
  if (userId !== null) {
    const rows = db
      .prepare(
        `SELECT genre, count(*) AS n FROM (
           SELECT e.genre FROM favorites f JOIN events e ON f.kind = 'event' AND e.id = f.ref_id WHERE f.user_id = ?
           UNION ALL SELECT e.genre FROM orders o JOIN events e ON e.id = o.event_id WHERE o.user_id = ? AND o.status IN ('paid','review','partially_refunded')
           UNION ALL SELECT j.value FROM favorites f JOIN artists a ON f.kind = 'artist' AND a.id = f.ref_id, json_each(a.genres) j WHERE f.user_id = ?
         ) WHERE genre IS NOT NULL GROUP BY genre`,
      )
      .all(userId, userId, userId) as { genre: string; n: number }[]
    for (const r of rows) genres.set(r.genre, r.n)
    for (const r of db.prepare("SELECT ref_id FROM favorites WHERE user_id = ? AND kind = 'artist'").all(userId) as { ref_id: number }[]) artists.add(r.ref_id)
    for (const r of db.prepare("SELECT event_id FROM orders WHERE user_id = ? AND status IN ('paid','review','partially_refunded')").all(userId) as { event_id: number }[]) owned.add(r.event_id)
    home = (db.prepare('SELECT home_city_id FROM users WHERE id = ?').get(userId) as { home_city_id: number | null }).home_city_id ?? cityId
  }
  const c = home ? (db.prepare('SELECT lat, lng FROM cities WHERE id = ?').get(home) as { lat: number; lng: number } | undefined) : undefined
  const profile: Profile = { genres, artists, home: c }
  const cands = db
    .prepare(`${COLS}, (SELECT group_concat(artist_id) FROM event_artists WHERE event_id = e.id) AS aids ${FROM} WHERE ${VISIBLE} AND e.status = 'published' AND e.starts_at > ?`)
    .all(new Date().toISOString()) as (EventRow & { aids: string | null })[]
  return cands
    .filter((e) => !owned.has(e.id))
    .map((e) => ({ e, s: score({ genre: e.genre, popularity: e.popularity, artistIds: e.aids ? e.aids.split(',').map(Number) : [], vlat: e.vlat, vlng: e.vlng }, profile) }))
    .sort((a, b) => b.s - a.s || a.e.starts_at.localeCompare(b.e.starts_at))
    .slice(0, limit)
    .map((x) => x.e)
}
