import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

// Temp DB, never data/ticketstorm.db. Set before lib/db.ts is imported (workers inherit the env).
const dir = mkdtempSync(join(tmpdir(), 'ticketstorm-'))
process.env.TICKETSTORM_DB = join(dir, 'test.db')
const { db, tx } = await import('../lib/db.ts')
const inv = await import('../lib/inventory.ts')
test.after(() => rmSync(dir, { recursive: true, force: true }))

const WORKERS = 8
const ITERATIONS = 200
const POOL = 6

const run = (sql: string, ...a: (string | number | null)[]) => Number(db.prepare(sql).run(...a).lastInsertRowid)
const orgId = run("INSERT INTO orgs (name, status) VALUES ('T','approved')")
const cityId = run("INSERT INTO cities (name, state, lat, lng) VALUES ('X','XX',0,0)")
const venueId = run("INSERT INTO venues (org_id, slug, name, address, city_id, lat, lng, tz) VALUES (?, 'v', 'V', 'a', ?, 0, 0, 'UTC')", orgId, cityId)

// One reserved section of `rows` x 8 seats (+ optional GA lawn) and an on-sale event with levels.
const makeEvent = (slug: string, rows: number, gaCapacity = 0) => tx(() => makeEventRows(slug, rows, gaCapacity))
function makeEventRows(slug: string, rows: number, gaCapacity: number) {
  const sec = run("INSERT INTO sections (venue_id, name, kind, path, label_x, label_y, rank) VALUES (?, ?, 'reserved', '', 0, 0, 1)", venueId, `S-${slug}`)
  for (let r = 0; r < rows; r++) {
    for (let n = 1; n <= 8; n++) {
      run('INSERT INTO seats (section_id, row, number, x, y, accessible, companion) VALUES (?,?,?,0,0,?,?)', sec, String.fromCharCode(65 + (r % 26)) + (r >= 26 ? Math.floor(r / 26) : ''), n, r === rows - 1 && n === 1 ? 1 : 0, 0)
    }
  }
  if (gaCapacity) run("INSERT INTO sections (venue_id, name, kind, capacity, path, label_x, label_y, rank) VALUES (?, ?, 'ga', ?, '', 0, 0, 2)", venueId, `Lawn-${slug}`, gaCapacity)
  const ev = run(
    `INSERT INTO events (org_id, venue_id, slug, title, category, starts_at, status, onsale_at, ticket_limit) VALUES (?,?,?,?, 'music', ?, 'published', ?, 4)`,
    orgId, venueId, slug, slug, new Date(Date.now() + 864e5 * 30).toISOString(), new Date(Date.now() - 864e5).toISOString(),
  )
  for (const [name, type] of [['General', 'standard'], ['Premium', 'standard'], ['VIP', 'vip'], ['Accessible', 'accessible'], ['Standing', 'standing']]) {
    run('INSERT INTO price_levels (event_id, name, price_cents, ticket_type) VALUES (?,?,1000,?)', ev, name, type)
  }
  inv.generateInventory(ev)
  return ev
}
const owner = (t: string) => ({ sessionToken: t, userId: null })
const seatIds = (ev: number) => (db.prepare('SELECT id FROM inventory WHERE event_id = ? AND seat_id IS NOT NULL ORDER BY id').all(ev) as { id: number }[]).map((r) => r.id)

test('8 connections race 200 iterations: no double holds, every hold all-or-nothing', async () => {
  const ev = makeEvent('race', (ITERATIONS * POOL) / 8) // 1200 seats; iteration i fights over seats [i*6, i*6+6)
  const ids = seatIds(ev)
  const pools = Array.from({ length: ITERATIONS }, (_, i) => ids.slice(i * POOL, (i + 1) * POOL))
  const counter = new SharedArrayBuffer(4)
  const results = await Promise.all(
    Array.from({ length: WORKERS }, (_, id) =>
      new Promise<{ wins: { holdId: number; ids: number[] }[]; conflicts: number }>((resolve, reject) => {
        const w = new Worker(new URL('./holds.worker.ts', import.meta.url), { workerData: { id, workers: WORKERS, iterations: ITERATIONS, pools, counter, eventId: ev } })
        w.on('message', resolve)
        w.on('error', reject)
      }),
    ),
  )
  const wins = results.flatMap((r) => r.wins)
  assert.ok(wins.length > 0 && results.some((r) => r.conflicts > 0), 'expected both wins and conflicts')

  // each seat is held by at most one successful hold
  const seen = new Set<number>()
  for (const w of wins) for (const id of w.ids) { assert.ok(!seen.has(id), `seat ${id} granted twice`); seen.add(id) }
  // DB agrees: every winning hold owns exactly its seats, and no failed attempt left anything behind
  for (const w of wins) {
    const rows = db.prepare("SELECT id FROM inventory WHERE hold_id = ? AND status = 'held'").all(w.holdId) as { id: number }[]
    assert.deepEqual(rows.map((r) => r.id).sort(), [...w.ids].sort())
  }
  assert.equal((db.prepare("SELECT count(*) AS n FROM inventory WHERE event_id = ? AND status = 'held'").get(ev) as { n: number }).n, seen.size)
  assert.equal((db.prepare("SELECT count(*) AS n FROM holds WHERE event_id = ?").get(ev) as { n: number }).n, wins.length)
})

test('expired hold can be taken over; unexpired cannot; release is owner-only', () => {
  const ev = makeEvent('expiry', 2)
  const [a, b] = seatIds(ev)
  const first = inv.holdSeats(ev, owner('A'), [a, b])
  assert.throws(() => inv.holdSeats(ev, owner('B'), [b]), inv.HoldError)
  assert.equal(inv.releaseHold(first.holdId, 'B'), false) // not the owner
  assert.equal(inv.getAvailability(ev).seats.find((s) => s[0] === b)![1], 'h')

  const past = new Date(Date.now() - 1000).toISOString()
  db.prepare('UPDATE inventory SET held_until = ? WHERE hold_id = ?').run(past, first.holdId)
  assert.equal(inv.getAvailability(ev).seats.find((s) => s[0] === b)![1], 'a') // lazily free, no job
  const second = inv.holdSeats(ev, owner('B'), [a, b])
  assert.deepEqual(db.prepare('SELECT hold_id FROM inventory WHERE id IN (?,?)').all(a, b).map((r) => r.hold_id), [second.holdId, second.holdId])
  assert.equal(inv.releaseHold(first.holdId, 'A'), true) // stale release must not free B's seats
  assert.equal((db.prepare("SELECT status FROM inventory WHERE id = ?").get(a) as { status: string }).status, 'held')
  assert.equal(inv.releaseHold(second.holdId, 'B'), true)
  assert.equal(inv.releaseHold(second.holdId, 'B'), false)
})

test('ticket_limit cap, replace-own-hold, all-or-nothing on partial conflict', () => {
  const ev = makeEvent('cap', 3)
  const ids = seatIds(ev)
  assert.throws(() => inv.holdSeats(ev, owner('C'), ids.slice(0, 5)), /1 to 4/)
  inv.holdSeats(ev, owner('D'), [ids[0]])
  assert.throws(() => inv.holdSeats(ev, owner('C'), [ids[1], ids[0]]), inv.HoldError)
  assert.equal((db.prepare("SELECT status FROM inventory WHERE id = ?").get(ids[1]) as { status: string }).status, 'available')
  const h1 = inv.holdSeats(ev, owner('C'), [ids[1]])
  const h2 = inv.holdSeats(ev, owner('C'), [ids[2]]) // replaces h1
  assert.equal((db.prepare("SELECT status FROM inventory WHERE id = ?").get(ids[1]) as { status: string }).status, 'available')
  assert.equal((db.prepare('SELECT status FROM holds WHERE id = ?').get(h1.holdId) as { status: string }).status, 'released')
  assert.ok(h2.holdId > h1.holdId)
})

test('best available gives adjacent seats in one row; GA decrements; accessible only on request', () => {
  const ev = makeEvent('best', 3, 10)
  const h = inv.holdBestAvailable(ev, owner('E'), 4)
  const rows = db.prepare('SELECT st.row, st.number FROM inventory i JOIN seats st ON st.id = i.seat_id WHERE i.hold_id = ? ORDER BY st.number').all(h.holdId) as { row: string; number: number }[]
  assert.equal(new Set(rows.map((r) => r.row)).size, 1)
  assert.deepEqual(rows.map((r) => r.number), [rows[0].number, rows[0].number + 1, rows[0].number + 2, rows[0].number + 3])

  const ada = inv.holdBestAvailable(ev, owner('F'), 1, undefined, true)
  assert.equal((db.prepare('SELECT st.accessible AS a FROM inventory i JOIN seats st ON st.id = i.seat_id WHERE i.hold_id = ?').get(ada.holdId) as { a: number }).a, 1)

  const lawn = (db.prepare("SELECT id FROM sections WHERE name = 'Lawn-best'").get() as { id: number }).id
  const free = () => inv.getAvailability(ev).ga.find((g) => g.sectionId === lawn)!.free
  assert.equal(free(), 10)
  inv.holdGA(ev, owner('G'), lawn, 3)
  assert.equal(free(), 7)
  inv.holdGA(ev, owner('H'), lawn, 4)
  assert.throws(() => inv.holdGA(ev, owner('I'), lawn, 4), /Only 3 left/)
  assert.equal(free(), 3)
})
