import test from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../lib/db.ts'
import { SCOPE_MILES, parseFilters, recommendedEvents, scopeCity, searchEvents, trendingEvents, withScope } from '../lib/events.ts'
import { topPicks } from '../lib/discover.ts'
import { haversineKm, miToKm } from '../lib/geo.ts'

// Needs the seeded DB (npm run reset): Boston now has a venue with upcoming events.
const boston = scopeCity(String((db.prepare("SELECT id FROM cities WHERE name = 'Boston'").get() as { id: number }).id))!
const c = db.prepare('SELECT lat, lng FROM cities WHERE id = ?').get(boston.id) as { lat: number; lng: number }
const near = (r: { vlat: number; vlng: number }) => haversineKm(c.lat, c.lng, r.vlat, r.vlng) <= miToKm(SCOPE_MILES)

test('scopeCity ignores junk cookies', () => {
  assert.equal(scopeCity(''), undefined)
  assert.equal(scopeCity('abc'), undefined)
  assert.equal(scopeCity('99999'), undefined)
})

test('home rails only hold events near the chosen city', () => {
  const rails = { trending: trendingEvents(9, boston.id), picks: recommendedEvents(null, boston.id, 6, boston.id), top: topPicks(6, boston.id) }
  for (const [name, rows] of Object.entries(rails)) {
    assert.ok(rows.length > 0, `${name} not empty`)
    assert.ok(rows.every(near), `${name} all within ${SCOPE_MILES} mi`)
  }
  assert.ok(trendingEvents(9).some((e) => !near(e)), 'national trending still spans other cities')
})

test('search defaults to the cookie city; explicit city overrides', () => {
  const scoped = searchEvents(withScope(parseFilters({}), {}, boston.id), 500)
  assert.ok(scoped.total > 0 && scoped.rows.every(near))
  const all = searchEvents(withScope(parseFilters({ city: '' }), { city: '' }, boston.id), 500)
  assert.ok(all.total > scoped.total, 'city= means all locations')
  const word = searchEvents(withScope(parseFilters({ city: 'all' }), { city: 'all' }, boston.id), 500)
  assert.equal(word.total, all.total)
  const other = db.prepare("SELECT id FROM cities WHERE name = 'Chicago'").get() as { id: number }
  const chi = searchEvents(withScope(parseFilters({ city: String(other.id) }), { city: String(other.id) }, boston.id), 500)
  assert.ok(chi.rows.length > 0 && chi.rows.every((r) => r.city === 'Chicago'))
})

test('every seeded city has upcoming events', () => {
  for (const { id, name } of db.prepare('SELECT id, name FROM cities WHERE country = ? OR country IS NULL').all('US') as { id: number; name: string }[])
    assert.ok(searchEvents({ city: id, unit: 'mi' }, 1).total > 0, name)
})
