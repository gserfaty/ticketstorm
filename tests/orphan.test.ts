import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'ticketstorm-'))
process.env.TICKETSTORM_DB = join(dir, 'test.db')
const { db } = await import('../lib/db.ts')
const inv = await import('../lib/inventory.ts')
test.after(() => rmSync(dir, { recursive: true, force: true }))

const run = (sql: string, ...a: (string | number | null)[]) => Number(db.prepare(sql).run(...a).lastInsertRowid)
const org = run("INSERT INTO orgs (name, status) VALUES ('T','approved')")
const city = run("INSERT INTO cities (name, state, lat, lng) VALUES ('X','XX',0,0)")

// Row letters -> seat counts. Section rank 3 -> every seat is General.
function makeEvent(slug: string, rows: Record<string, number>) {
  const venue = run("INSERT INTO venues (org_id, slug, name, address, city_id, lat, lng, tz) VALUES (?,?,?,'a',?,0,0,'UTC')", org, slug, slug, city)
  const sec = run("INSERT INTO sections (venue_id, name, kind, path, label_x, label_y, rank) VALUES (?, ?, 'reserved', '', 0, 0, 3)", venue, slug)
  for (const [row, n] of Object.entries(rows)) for (let i = 1; i <= n; i++) run('INSERT INTO seats (section_id, row, number, x, y) VALUES (?,?,?,0,0)', sec, row, i)
  const ev = run("INSERT INTO events (org_id, venue_id, slug, title, category, starts_at, status, onsale_at) VALUES (?,?,?,?, 'music', ?, 'published', ?)", org, venue, slug, slug, new Date(Date.now() + 864e5).toISOString(), new Date(Date.now() - 864e5).toISOString())
  for (const n of ['General', 'Premium', 'VIP', 'Accessible']) run('INSERT INTO price_levels (event_id, name, price_cents, ticket_type) VALUES (?,?,5000,?)', ev, n, 'standard')
  inv.generateInventory(ev)
  const seat = (row: string, n: number) => (db.prepare('SELECT i.id FROM inventory i JOIN seats st ON st.id = i.seat_id WHERE i.event_id = ? AND st.row = ? AND st.number = ?').get(ev, row, n) as { id: number }).id
  const setStatus = (row: string, n: number, status: string) => db.prepare('UPDATE inventory SET status = ?, held_until = ? WHERE id = ?').run(status, status === 'held' ? new Date(Date.now() + 60_000).toISOString() : null, seat(row, n))
  return { ev, seat, setStatus }
}
const who = (t: string) => ({ sessionToken: t, userId: null })
const nums = (holdId: number) => (db.prepare('SELECT st.row, st.number FROM inventory i JOIN seats st ON st.id = i.seat_id WHERE i.hold_id = ? ORDER BY st.row, st.number').all(holdId) as { row: string; number: number }[]).map((r) => r.row + r.number)

test('orphanSeat: pure rule', () => {
  const row = (free: string) => [...free].map((c, i) => ({ number: i + 1, free: c === 'f' }))
  const pick = (...n: number[]) => new Set(n)
  assert.equal(inv.orphanSeat(row('ffff'), pick(1, 3)), 2) // gap between two picks
  assert.equal(inv.orphanSeat(row('fftf'), pick(1)), 2) // seat 2 between pick and taken
  assert.equal(inv.orphanSeat(row('ffff'), pick(2, 3)), 1) // row edge
  assert.equal(inv.orphanSeat(row('ffff'), pick(1, 2)), undefined)
  assert.equal(inv.orphanSeat(row('ffff'), pick(1, 2, 3, 4)), undefined) // whole row
  assert.equal(inv.orphanSeat(row('ffff'), pick(2, 3, 4)), 1)
  assert.equal(inv.orphanSeat(row('tfft'), pick(2, 3)), undefined) // fills the hole exactly
  assert.equal(inv.orphanSeat(row('tftf'), pick(4)), undefined) // pre-existing single seat 2 is not next to the pick
  assert.equal(inv.orphanSeat([{ number: 1, free: true }, { number: 2, free: true }, { number: 4, free: true }, { number: 5, free: true }], pick(1, 2)), undefined) // an aisle gap is just an edge
  assert.equal(inv.orphanSeat([{ number: 1, free: true }, { number: 2, free: true }, { number: 4, free: true }], pick(1)), 2) // seat 2 has an aisle on its other side
})

test('manual selection: seats 1 and 3 with 2 free and 4 taken is rejected with a clear message; nothing is held', () => {
  const { ev, seat, setStatus } = makeEvent('manual', { A: 8 })
  setStatus('A', 4, 'sold')
  assert.throws(() => inv.holdSeats(ev, who('m1'), [seat('A', 1), seat('A', 3)]), /Seat 2 in Section manual Row A would be left empty on its own/)
  assert.equal((db.prepare("SELECT count(*) AS n FROM inventory WHERE event_id = ? AND status = 'held'").get(ev) as { n: number }).n, 0)
  assert.equal((db.prepare("SELECT count(*) AS n FROM holds WHERE event_id = ?").get(ev) as { n: number }).n, 0) // the hold row rolled back too
  inv.holdSeats(ev, who('m1'), [seat('A', 1), seat('A', 2), seat('A', 3)]) // filling the hole up to the taken seat is fine
})

test('row edge: leaving one seat at the end of the row is rejected, taking the end seat is fine', () => {
  const { ev, seat } = makeEvent('edge', { A: 6 })
  assert.throws(() => inv.holdSeats(ev, who('e1'), [seat('A', 2), seat('A', 3)]), /Seat 1 /)
  assert.throws(() => inv.holdSeats(ev, who('e1'), [seat('A', 4), seat('A', 5)]), /Seat 6 /)
  inv.holdSeats(ev, who('e1'), [seat('A', 1), seat('A', 2)])
})

test('held, sold and blocked seats all count as taken', () => {
  const { ev, seat, setStatus } = makeEvent('taken', { A: 6, B: 6, C: 6 })
  setStatus('A', 4, 'held')
  setStatus('B', 4, 'sold')
  setStatus('C', 4, 'blocked')
  for (const row of ['A', 'B', 'C']) assert.throws(() => inv.holdSeats(ev, who('t1'), [seat(row, 1), seat(row, 3)]), /would be left empty/)
})

test("the caller's own previous hold does not count as taken (it is replaced)", () => {
  const { ev, seat } = makeEvent('own', { A: 8 })
  inv.holdSeats(ev, who('o1'), [seat('A', 1), seat('A', 2)])
  // o1 re-picks 3-4: its old seats 1-2 are released first, so seat 1-2 are a free run of 2, not strands
  inv.holdSeats(ev, who('o1'), [seat('A', 3), seat('A', 4)])
  // another shopper taking 6-7 would leave seat 5 alone between o1's seat 4 and the pick
  assert.throws(() => inv.holdSeats(ev, who('o2'), [seat('A', 6), seat('A', 7)]), /Seat 5 /) // 5 sits between o1's seat 4 and the pick
})

test('Best Available respects the rule: it will not leave a single seat', () => {
  // row A has exactly 3 free seats (1-3, 4 sold): 2 together would strand one, so Best Available takes the roomy row B instead
  const { ev, setStatus } = makeEvent('best', { A: 4, B: 8 })
  setStatus('A', 4, 'sold')
  const h = inv.holdBestAvailable(ev, who('b1'), 2)
  assert.deepEqual(nums(h.holdId), ['B1', 'B2'])
  // qty 3 fits row A exactly (fills it to the taken seat)
  const h3 = inv.holdBestAvailable(ev, who('b2'), 3)
  assert.deepEqual(nums(h3.holdId), ['A1', 'A2', 'A3'])
  // qty 2 again for another shopper: row B has 3-8 free, taking 3-4 is fine
  assert.deepEqual(nums(inv.holdBestAvailable(ev, who('b3'), 2).holdId), ['B3', 'B4'])
  // nothing but a stranding fit left: rows are B5-B8 (4 seats) -> 3 would strand one at either end
  assert.throws(() => inv.holdBestAvailable(ev, who('b4'), 3), /No 3 adjacent seats/)
})
