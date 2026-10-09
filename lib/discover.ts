import { db } from './db.ts'
import { CATEGORIES, eventsByIds, listEvents, trendingEvents } from './events.ts'
import type { EventRow } from './events.ts'

export const PER_PAGE = 20

// Pure. `page` comes from the URL, so anything odd (NaN, 0, huge) is clamped into 1..pages.
export function pageMath(total: number, rawPage: unknown, per = PER_PAGE) {
  const pages = Math.max(1, Math.ceil(total / per))
  const n = Number(rawPage)
  const page = Number.isInteger(n) ? Math.min(Math.max(n, 1), pages) : 1
  const offset = (page - 1) * per
  return { page, pages, offset, count: Math.max(0, Math.min(per, total - offset)) }
}

// The most popular upcoming event of each category.
export function topPicks(limit = 6, cityId?: number): EventRow[] {
  if (cityId) {
    const seen = new Set<string>()
    return trendingEvents(1e6, cityId).filter((e) => !seen.has(e.category) && seen.add(e.category)).slice(0, limit)
  }
  const best = db
    .prepare(
      `SELECT id FROM events e WHERE e.status = 'published' AND e.approved = 1 AND e.starts_at > ? AND (e.onsale_at IS NULL OR e.onsale_at <= ?)
         AND e.id = (SELECT e2.id FROM events e2 WHERE e2.category = e.category AND e2.status = 'published' AND e2.approved = 1 AND e2.starts_at > ?
                     ORDER BY e2.popularity DESC, e2.starts_at LIMIT 1)
       ORDER BY e.popularity DESC LIMIT ?`,
    )
    .all(new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), limit) as { id: number }[]
  return eventsByIds(best.map((b) => b.id)).sort((a, b) => b.popularity - a.popularity)
}

// Same category and either the same genre or a shared artist; not the same tour (those are "other dates").
export function relatedEvents(e: { id: number; category: string; genre: string | null; series_key: string | null }, limit = 4): EventRow[] {
  return listEvents(
    `e.id != ? AND e.category = ? AND (e.series_key IS NULL OR e.series_key IS NOT ?) AND e.status = 'published' AND (e.genre IS ? OR EXISTS
       (SELECT 1 FROM event_artists a JOIN event_artists b ON b.artist_id = a.artist_id WHERE a.event_id = e.id AND b.event_id = ?))`,
    [e.id, e.category, e.series_key, e.genre, e.id],
    200,
  )
    .sort((a, b) => b.popularity - a.popularity || a.starts_at.localeCompare(b.starts_at))
    .slice(0, limit)
}

// Anonymous count only: sessions holding seats for the event right now + waiting-room entries seen in the last 5 minutes.
export function viewingNow(eventId: number, now = Date.now()): number {
  const n = (sql: string, ...a: (string | number)[]) => (db.prepare(sql).get(...a) as { n: number }).n
  return (
    n("SELECT count(DISTINCT session_token) AS n FROM holds WHERE event_id = ? AND status = 'active' AND expires_at > ?", eventId, new Date(now).toISOString()) +
    n('SELECT count(*) AS n FROM queue_entries WHERE event_id = ? AND seen_at > ?', eventId, new Date(now - 5 * 60_000).toISOString())
  )
}

export type Guide = { slug: string; kind: string; title: string; blurb: string; city_id: number | null; items: { slug: string; note: string }[] }
const parse = (r: Omit<Guide, 'items'> & { items: string }): Guide => ({ ...r, items: JSON.parse(r.items) })
export const listDiscover = (): Guide[] => (db.prepare('SELECT * FROM discover ORDER BY kind DESC, title').all() as (Omit<Guide, 'items'> & { items: string })[]).map(parse)
export const getDiscover = (slug: string): Guide | undefined => {
  const r = db.prepare('SELECT * FROM discover WHERE slug = ?').get(slug) as (Omit<Guide, 'items'> & { items: string }) | undefined
  return r && parse(r)
}

// Events of a list in the editor's order (unknown or no-longer-public slugs are skipped).
export function guideEvents(g: Guide): { e: EventRow; note: string }[] {
  const rows = new Map(
    (db.prepare(`SELECT id, slug FROM events WHERE slug IN (${g.items.map(() => '?').join(',') || "''"})`).all(...g.items.map((i) => i.slug)) as { id: number; slug: string }[]).map((r) => [r.slug, r.id]),
  )
  const byId = new Map(eventsByIds([...rows.values()]).map((e) => [e.id, e]))
  return g.items.flatMap((i) => {
    const e = byId.get(rows.get(i.slug) ?? 0)
    return e && Date.parse(e.starts_at) > Date.now() ? [{ e, note: i.note }] : []
  })
}

export const categoryName = (slug: string) => CATEGORIES.find((c) => c.slug === slug)?.name ?? slug
