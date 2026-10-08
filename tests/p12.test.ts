import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'ticketstorm-'))
process.env.TICKETSTORM_DB = join(dir, 'test.db')
const { db } = await import('../lib/db.ts')
const inv = await import('../lib/inventory.ts')
const { pageMath, viewingNow, relatedEvents, topPicks } = await import('../lib/discover.ts')
const { sitemapEntries } = await import('../lib/seo.ts')
const { weather } = await import('../lib/weather.ts')
const { searchEvents } = await import('../lib/events.ts')
test.after(() => rmSync(dir, { recursive: true, force: true }))

const run = (sql: string, ...a: (string | number | null)[]) => Number(db.prepare(sql).run(...a).lastInsertRowid)
const org = run("INSERT INTO orgs (name, status) VALUES ('T','approved')")
const city = run("INSERT INTO cities (name, state, lat, lng, tax_rate_bps) VALUES ('X','XX',40,-75,1000)")
const venue = run("INSERT INTO venues (org_id, slug, name, address, city_id, lat, lng, tz) VALUES (?, 'v','V','a',?,40,-75,'UTC')", org, city)
const sec = run("INSERT INTO sections (venue_id, name, kind, path, label_x, label_y, rank) VALUES (?, 'S', 'reserved', '', 0, 0, 1)", venue)
for (let n = 1; n <= 10; n++) run("INSERT INTO seats (section_id, row, number, x, y) VALUES (?, 'A', ?, 0, 0)", sec, n)
const mkEvent = (slug: string, o: { status?: string; approved?: number; days?: number; category?: string; genre?: string; pop?: number } = {}) => {
  const ev = run("INSERT INTO events (org_id, venue_id, slug, title, category, genre, starts_at, status, approved, popularity, ticket_limit) VALUES (?,?,?,?,?,?,?,?,?,?,8)",
    org, venue, slug, slug, o.category ?? 'music', o.genre ?? 'Pop', new Date(Date.now() + (o.days ?? 5) * 864e5).toISOString(), o.status ?? 'published', o.approved ?? 1, o.pop ?? 0)
  for (const n of ['General', 'Premium', 'VIP', 'Accessible']) run('INSERT INTO price_levels (event_id, name, price_cents, ticket_type) VALUES (?,?,5000,?)', ev, n, 'standard')
  inv.generateInventory(ev)
  return ev
}

test('pageMath clamps junk page numbers and counts the last partial page', () => {
  assert.deepEqual(pageMath(45, '2', 20), { page: 2, pages: 3, offset: 20, count: 20 })
  assert.deepEqual(pageMath(45, '3', 20), { page: 3, pages: 3, offset: 40, count: 5 })
  assert.equal(pageMath(45, '99', 20).page, 3)
  for (const bad of ['0', '-4', 'abc', undefined, '1.5', NaN]) assert.equal(pageMath(45, bad, 20).page, 1)
  assert.deepEqual(pageMath(0, '5', 20), { page: 1, pages: 1, offset: 0, count: 0 })
})

test('searchEvents offset walks the same ordered list without gaps or repeats', () => {
  for (let i = 0; i < 7; i++) mkEvent(`pg-${i}`, { days: 10 + i, category: 'comedy' })
  const all = searchEvents({ category: 'comedy', unit: 'mi' }, 100).rows.map((r) => r.slug)
  assert.equal(all.length, 7)
  const pages = [0, 3, 6].flatMap((o) => searchEvents({ category: 'comedy', unit: 'mi' }, 3, { offset: o }).rows.map((r) => r.slug))
  assert.deepEqual(pages, all)
  assert.equal(searchEvents({ category: 'comedy', unit: 'mi' }, 3, { offset: 6 }).total, 7)
})

test('sitemap lists public upcoming events only', () => {
  mkEvent('pub-1')
  mkEvent('hidden-draft', { status: 'draft' })
  mkEvent('hidden-unapproved', { approved: 0 })
  mkEvent('hidden-past', { days: -3 })
  const urls = sitemapEntries().map((e) => e.url)
  assert.ok(urls.some((u) => u.endsWith('/events/pub-1')))
  for (const s of ['hidden-draft', 'hidden-unapproved', 'hidden-past']) assert.ok(!urls.some((u) => u.endsWith(`/events/${s}`)), s)
  assert.ok(urls.some((u) => u.endsWith('/venues/v')))
})

test('simulated weather is deterministic per date and city', () => {
  assert.deepEqual(weather('2026-07-04', 'Boston', 42), weather('2026-07-04', 'Boston', 42))
  const days = new Set(Array.from({ length: 20 }, (_, i) => JSON.stringify(weather(`2026-07-${String(i + 1).padStart(2, '0')}`, 'Boston', 42))))
  assert.ok(days.size > 5)
  assert.ok(weather('2026-07-04', 'Boston', 42).highC > weather('2026-01-04', 'Boston', 42).highC)
})

test('viewing count = distinct sessions holding seats + recent waiting-room entries, nothing else', () => {
  const ev = mkEvent('viewed')
  assert.equal(viewingNow(ev), 0)
  inv.holdBestAvailable(ev, { sessionToken: 'a', userId: null }, 2)
  inv.holdBestAvailable(ev, { sessionToken: 'b', userId: null }, 1)
  assert.equal(viewingNow(ev), 2)
  run("INSERT INTO queue_entries (event_id, session_token, rank, joined_at, seen_at) VALUES (?, 'q1', 1, ?, ?)", ev, new Date().toISOString(), new Date().toISOString())
  run("INSERT INTO queue_entries (event_id, session_token, rank, joined_at, seen_at) VALUES (?, 'q2', 2, ?, ?)", ev, new Date().toISOString(), new Date(Date.now() - 10 * 60_000).toISOString())
  assert.equal(viewingNow(ev), 3)
})

test('related events share a category and genre or artist, never the event itself or its own tour', () => {
  const a = mkEvent('rel-a', { category: 'sports', genre: 'Hockey', pop: 10 })
  const b = mkEvent('rel-b', { category: 'sports', genre: 'Hockey', pop: 90 })
  mkEvent('rel-c', { category: 'sports', genre: 'Soccer' })
  mkEvent('rel-d', { category: 'music', genre: 'Hockey' })
  const slugs = relatedEvents({ id: a, category: 'sports', genre: 'Hockey', series_key: null }).map((e) => e.slug)
  assert.deepEqual(slugs, ['rel-b'])
  assert.ok(b)
  assert.ok(topPicks().length > 0)
})
