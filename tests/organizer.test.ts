import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

const dir = mkdtempSync(join(tmpdir(), 'ticketstorm-'))
process.env.TICKETSTORM_DB = join(dir, 'test.db')
const { db } = await import('../lib/db.ts')
const inv = await import('../lib/inventory.ts')
const { finalize, refundEvent } = await import('../lib/orders.ts')
const { makeToken } = await import('../lib/safetix.ts')
const { scanTicket, attendance } = await import('../lib/scan.ts')
const org = await import('../lib/organizer.ts')
const { UserError, setFlag } = await import('../lib/platform.ts')
test.after(() => rmSync(dir, { recursive: true, force: true }))

const run = (sql: string, ...a: (string | number | null)[]) => Number(db.prepare(sql).run(...a).lastInsertRowid)
const orgId = run("INSERT INTO orgs (name, status) VALUES ('T','approved')")
const city = run("INSERT INTO cities (name, state, lat, lng, tax_rate_bps) VALUES ('X','XX',0,0,1000)")
const venue = run("INSERT INTO venues (org_id, slug, name, address, city_id, lat, lng, tz) VALUES (?, 'v','V','a',?,0,0,'America/Chicago')", orgId, city)
const sec = run("INSERT INTO sections (venue_id, name, kind, path, label_x, label_y, rank) VALUES (?, 'S', 'reserved', '', 0, 0, 1)", venue)
for (let n = 1; n <= 60; n++) run("INSERT INTO seats (section_id, row, number, x, y) VALUES (?, 'A', ?, 0, 0)", sec, n)
const scanner = run("INSERT INTO users (email, name) VALUES ('s@x.test','S')")

let k = 0
function makeEvent(slug: string) {
  const ev = run("INSERT INTO events (org_id, venue_id, slug, title, category, starts_at, status, onsale_at) VALUES (?,?,?,?, 'music', ?, 'published', ?)", orgId, venue, slug, slug, new Date(Date.now() + 864e5).toISOString(), new Date(Date.now() - 864e5).toISOString())
  run("INSERT INTO price_levels (event_id, name, price_cents, ticket_type) VALUES (?, 'Only', 5000, 'standard')", ev)
  inv.generateInventory(ev)
  return ev
}
// one-seat order through the real checkout path
function buy(ev: number, last4 = '4242', email = `b${k}@x.test`) {
  const session = `sess-${++k}`
  const h = inv.holdBestAvailable(ev, { sessionToken: session, userId: null }, 1).holdId
  const r = finalize({ holdId: h, sessionToken: session, userId: null, email, key: `key-${k}-padding`, method: 'card', brand: 'Visa', last4, exp: '12/39', save: false, billing: { name: 'G', address: 'a', city: 'c', zip: '1' } })
  assert.ok('orderId' in r)
  const t = db.prepare('SELECT id, secret FROM tickets WHERE order_id = ?').get((r as { orderId: number }).orderId) as { id: number; secret: string }
  return { orderId: (r as { orderId: number }).orderId, ticketId: t.id, secret: t.secret }
}
const scan = (ev: number, t: { ticketId: number; secret: string }, ms = Date.now()) => scanTicket(ev, makeToken(t.ticketId, t.secret, ms), scanner)

test('scan: valid, already used (venue time), expired, forged, wrong event', () => {
  const ev = makeEvent('scan1')
  const other = makeEvent('scan2')
  const t = buy(ev)
  assert.equal(scan(other, t).result, 'wrong_event')
  assert.equal(scanTicket(ev, makeToken(t.ticketId, 'not-the-secret'), scanner).result, 'invalid')
  assert.equal(scan(ev, t, Date.now() - 120_000).result, 'expired')
  assert.equal(attendance(ev).scanned, 0)
  assert.equal(scan(ev, t).result, 'valid')
  const again = scan(ev, t)
  assert.equal(again.result, 'used')
  assert.match(again.message, /Already scanned at \d\d:\d\d/)
  assert.equal(scan(ev, t, Date.now() - 120_000).result, 'expired')
  assert.deepEqual({ ...attendance(ev) }, { scanned: 1, total: 1 })
})

test('concurrent scans of one ticket from 8 connections: exactly one Valid', async () => {
  const ev = makeEvent('race')
  const tickets = Array.from({ length: 40 }, () => buy(ev))
  const tokens = tickets.map((t) => makeToken(t.ticketId, t.secret))
  const counter = new SharedArrayBuffer(4)
  const WORKERS = 8
  const out = await Promise.all(
    Array.from({ length: WORKERS }, () =>
      new Promise<string[]>((resolve, reject) => {
        const w = new Worker(new URL('./scan.worker.ts', import.meta.url), { workerData: { eventId: ev, userId: scanner, tokens, workers: WORKERS, counter } })
        w.on('message', resolve)
        w.on('error', reject)
      }),
    ),
  )
  for (let i = 0; i < tickets.length; i++) {
    const rs = out.map((r) => r[i])
    assert.equal(rs.filter((r) => r === 'valid').length, 1, `ticket ${i}: ${rs}`)
    assert.equal(rs.filter((r) => r === 'used').length, WORKERS - 1)
  }
  assert.equal(attendance(ev).scanned, 40)
})

test('refundEvent: refunds, cancels tickets, emails, idempotent; a failing refund is flagged, not marked refunded', () => {
  const ev = makeEvent('cancel')
  const a = buy(ev, '4242', 'a@x.test')
  const bad = buy(ev, '0341', 'bad@x.test')
  const emails = () => (db.prepare("SELECT count(*) AS n FROM outbox WHERE subject LIKE '%cancelled%'").get() as { n: number }).n
  const okRefunds = () => (db.prepare("SELECT count(*) AS n FROM payments WHERE kind = 'refund' AND status = 'succeeded'").get() as { n: number }).n
  const order = (id: number) => db.prepare('SELECT status, refund_error, total FROM orders WHERE id = ?').get(id) as { status: string; refund_error: string | null; total: number }

  assert.deepEqual(refundEvent(ev), { refunded: 1, failed: 1 })
  assert.equal(order(a.orderId).status, 'refunded')
  assert.equal(order(bad.orderId).status, 'cancelled')
  assert.equal(order(bad.orderId).refund_error, 'refund_failed')
  const refund = db.prepare("SELECT amount FROM payments WHERE order_id = ? AND kind = 'refund'").get(a.orderId) as { amount: number }
  assert.equal(refund.amount, order(a.orderId).total)
  assert.equal(refund.amount, (db.prepare('SELECT sum(unit_cents + fee_cents + tax_cents) AS s FROM order_items WHERE order_id = ?').get(a.orderId) as { s: number }).s)
  assert.equal((db.prepare("SELECT count(*) AS n FROM tickets WHERE status = 'cancelled' AND order_id IN (?,?)").get(a.orderId, bad.orderId) as { n: number }).n, 2)
  assert.equal(db.prepare('SELECT status FROM events WHERE id = ?').get(ev)!.status, 'cancelled')
  assert.equal(emails(), 2)
  assert.equal(scan(ev, a).result, 'invalid') // cancelled ticket does not scan

  // run again: nothing double-refunded, nobody emailed twice, the failing order stays flagged
  const before = okRefunds()
  assert.deepEqual(refundEvent(ev), { refunded: 0, failed: 1 })
  assert.equal(okRefunds(), before)
  assert.equal(emails(), 2)
  assert.equal(order(bad.orderId).refund_error, 'refund_failed')
})

test('reschedule keeps tickets valid and tells holders; postpone too', () => {
  const ev = makeEvent('move')
  const t = buy(ev, '4242', 'holder@x.test')
  const next = new Date(Date.now() + 5 * 864e5).toISOString()
  org.changeDate(ev, 'rescheduled', next)
  const e = db.prepare('SELECT status, starts_at FROM events WHERE id = ?').get(ev) as { status: string; starts_at: string }
  assert.deepEqual({ ...e }, { status: 'rescheduled', starts_at: next })
  assert.equal(db.prepare('SELECT status FROM tickets WHERE id = ?').get(t.ticketId)!.status, 'valid')
  assert.equal((db.prepare("SELECT count(*) AS n FROM outbox WHERE \"to\" = 'holder@x.test' AND subject LIKE '%rescheduled'").get() as { n: number }).n, 1)
  org.changeDate(ev, 'postponed')
  assert.equal(db.prepare('SELECT status FROM tickets WHERE id = ?').get(t.ticketId)!.status, 'valid')
  assert.throws(() => org.changeDate(ev, 'rescheduled', new Date(Date.now() - 1000).toISOString()), UserError)
})

test('publishing: pending orgs refused; approval flag hides new events until admin approves', () => {
  const pending = run("INSERT INTO orgs (name, status) VALUES ('P','pending')")
  const pv = run("INSERT INTO venues (org_id, slug, name, address, city_id, lat, lng, tz) VALUES (?, 'pv','PV','a',?,0,0,'UTC')", pending, city)
  run("INSERT INTO sections (venue_id, name, kind, path, label_x, label_y, rank) VALUES (?, 'S', 'ga', '', 0, 0, 1)", pv)
  run("UPDATE sections SET capacity = 5 WHERE venue_id = ?", pv)
  const id = org.createEvent(pending, { title: 'Mine', category: 'music', genre: '', venueId: pv, startsAt: new Date(Date.now() + 864e5).toISOString(), doorsAt: null, image: '', description: '' })
  org.addLevel(id, 'Floor', '25', 'standing', '#000000')
  assert.throws(() => org.publishEvent(id), /awaiting admin approval/)
  // org cannot attach another org's venue
  assert.throws(() => org.createEvent(pending, { title: 'x', category: 'music', genre: '', venueId: venue, startsAt: new Date().toISOString(), doorsAt: null, image: '', description: '' }), UserError)
  db.prepare("UPDATE orgs SET status = 'approved' WHERE id = ?").run(pending)
  setFlag('require_event_approval', true)
  org.publishEvent(id)
  const e = db.prepare('SELECT status, approved FROM events WHERE id = ?').get(id) as { status: string; approved: number }
  assert.deepEqual({ ...e }, { status: 'published', approved: 0 })
  assert.equal((db.prepare('SELECT count(*) AS n FROM inventory WHERE event_id = ?').get(id) as { n: number }).n, 5)
  setFlag('require_event_approval', false)
})

test('killed row is blocked and cannot be held; sold seats are untouched', () => {
  const ev = makeEvent('kill')
  const sold = buy(ev)
  const soldInv = (db.prepare('SELECT inventory_id AS i FROM tickets WHERE id = ?').get(sold.ticketId) as { i: number }).i
  const n = org.applyInventory(ev, sec, 'A', 'kill')
  assert.equal(n, 59)
  assert.equal(db.prepare('SELECT status FROM inventory WHERE id = ?').get(soldInv)!.status, 'sold')
  assert.throws(() => inv.holdBestAvailable(ev, { sessionToken: 'k', userId: null }, 1))
  assert.equal(org.applyInventory(ev, sec, 'A', 'release'), 59)
  assert.ok(inv.holdBestAvailable(ev, { sessionToken: 'k', userId: null }, 1))
})

test('single-seat kill, doors/on-sale validation', () => {
  const ev = makeEvent('single')
  assert.equal(org.applyInventory(ev, sec, 'A', 'kill', undefined, 3, 3), 1)
  assert.equal(org.applyInventory(ev, sec, 'A', 'kill', undefined, 5, 7), 3)
  assert.throws(() => org.applyInventory(ev, sec, '', 'kill', undefined, 1, 2), UserError)
  assert.throws(() => org.setOnsale(ev, new Date(Date.now() + 9 * 864e5).toISOString()), /before the event/)
  const base = { title: 't', category: 'music', genre: '', venueId: venue, image: '', description: '' }
  const s = new Date(Date.now() + 864e5).toISOString()
  assert.throws(() => org.createEvent(orgId, { ...base, startsAt: s, doorsAt: new Date(Date.now() + 2 * 864e5).toISOString() }), /Doors/)
})
