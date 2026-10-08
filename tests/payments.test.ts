import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'ticketstorm-'))
process.env.TICKETSTORM_DB = join(dir, 'test.db')
const { db } = await import('../lib/db.ts')
const inv = await import('../lib/inventory.ts')
const { finalize, approve3ds, canViewOrder } = await import('../lib/orders.ts')
const pay = await import('../lib/payments.ts')
const { price } = await import('../lib/pricing.ts')
test.after(() => rmSync(dir, { recursive: true, force: true }))

const run = (sql: string, ...a: (string | number | null)[]) => Number(db.prepare(sql).run(...a).lastInsertRowid)
const org = run("INSERT INTO orgs (name, status) VALUES ('T','approved')")
const city = run("INSERT INTO cities (name, state, lat, lng, tax_rate_bps) VALUES ('X','XX',0,0,1000)")
const venue = run("INSERT INTO venues (org_id, slug, name, address, city_id, lat, lng, tz) VALUES (?, 'v','V','a',?,0,0,'UTC')", org, city)
const sec = run("INSERT INTO sections (venue_id, name, kind, path, label_x, label_y, rank) VALUES (?, 'S', 'reserved', '', 0, 0, 1)", venue)
for (let n = 1; n <= 20; n++) run("INSERT INTO seats (section_id, row, number, x, y) VALUES (?, 'A', ?, 0, 0)", sec, n)
const ev = run("INSERT INTO events (org_id, venue_id, slug, title, category, starts_at, status, onsale_at) VALUES (?,?, 'e','E','music',?, 'published', ?)", org, venue, new Date(Date.now() + 864e5).toISOString(), new Date(Date.now() - 864e5).toISOString())
for (const n of ['General', 'Premium', 'VIP', 'Accessible']) run('INSERT INTO price_levels (event_id, name, price_cents, ticket_type) VALUES (?,?,5000,?)', ev, n, 'standard')
inv.generateInventory(ev)

let n = 0
const hold = (session: string, qty = 2) => inv.holdBestAvailable(ev, { sessionToken: session, userId: null }, qty).holdId
const input = (holdId: number, session: string, last4: string, key = `key-${++n}-padding`) => ({
  holdId, sessionToken: session, userId: null, email: 'g@x.test', key, method: 'card' as const, brand: 'Visa', last4, exp: '12/39', save: false,
  billing: { name: 'G', address: 'a', city: 'c', zip: '1' },
})
const count = (t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n

test('test cards and Luhn', () => {
  const ok = (number: string) => pay.validateCard({ number, exp: '12/39', cvc: '123' })
  assert.equal(ok('4242424242424242'), null)
  assert.match(ok('4242424242424241')!, /invalid/)
  assert.match(pay.validateCard({ number: '4242424242424242', exp: '01/20', cvc: '123' })!, /expired/)
  assert.equal(pay.charge('4242').status, 'succeeded')
  assert.deepEqual(pay.charge('0002'), { status: 'declined', code: 'card_declined' })
  assert.deepEqual(pay.charge('9995'), { status: 'declined', code: 'insufficient_funds' })
  assert.equal(pay.charge('3220').status, 'requires_3ds')
  assert.equal(pay.charge('0341').status, 'succeeded')
})

test('totals: fees and tax add up, total = sum of lines', () => {
  const p = price([5000, 5000, 0], { service_pct: 10, facility_cents: 300, order_cents: 250 }, 1000)
  assert.equal(p.total, p.subtotal + p.fees + p.tax)
  assert.equal(p.fees, p.lineFees.reduce((a, b) => a + b) + 250)
  assert.equal(p.subtotal, 10000)
})

test('success creates order, sold inventory, tickets; same key charges once', () => {
  const h = hold('s1')
  const r = finalize(input(h, 's1', '4242', 'idem-same-key'))
  assert.ok('orderId' in r)
  const again = finalize(input(h, 's1', '4242', 'idem-same-key'))
  assert.deepEqual(again, r)
  assert.equal(db.prepare("SELECT count(*) AS n FROM payments WHERE idempotency_key = 'idem-same-key'").get()!.n, 1)
  assert.equal(db.prepare('SELECT count(*) AS n FROM tickets WHERE order_id = ?').get((r as { orderId: number }).orderId)!.n, 2)
  assert.equal(db.prepare("SELECT count(*) AS n FROM inventory WHERE hold_id = ? AND status = 'sold'").get(h)!.n, 2)
  const o = db.prepare('SELECT subtotal, fees, tax, total FROM orders WHERE id = ?').get((r as { orderId: number }).orderId) as { subtotal: number; fees: number; tax: number; total: number }
  assert.equal(o.total, o.subtotal + o.fees + o.tax)
  assert.equal(o.total, (db.prepare('SELECT sum(unit_cents + fee_cents + tax_cents) AS s FROM order_items WHERE order_id = ?').get((r as { orderId: number }).orderId) as { s: number }).s)
  // a different session cannot replay someone else's key
  assert.throws(() => finalize(input(h, 's2', '4242', 'idem-same-key')))
})

test('declines keep the hold; retry with a new key works', () => {
  const h = hold('s3')
  assert.deepEqual(finalize(input(h, 's3', '0002')), { declined: 'card_declined' })
  assert.deepEqual(finalize(input(h, 's3', '9995')), { declined: 'insufficient_funds' })
  assert.equal(db.prepare('SELECT status FROM holds WHERE id = ?').get(h)!.status, 'active')
  assert.ok('orderId' in finalize(input(h, 's3', '4242')))
})

test('3DS: approval finalizes, only for the owning session', () => {
  const h = hold('s4')
  const r = finalize(input(h, 's4', '3220'))
  assert.ok('threeDs' in r)
  const id = (r as { threeDs: number }).threeDs
  assert.throws(() => approve3ds(id, 'other'))
  assert.ok('orderId' in approve3ds(id, 's4'))
})

test('paying after expiry (or as another session) creates nothing', () => {
  const h = hold('s5')
  const before = [count('orders'), count('tickets'), count('payments')]
  assert.throws(() => finalize(input(h, 'intruder', '4242')))
  db.prepare("UPDATE holds SET expires_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(h)
  assert.throws(() => finalize(input(h, 's5', '4242')))
  assert.deepEqual([count('orders'), count('tickets'), count('payments')], before)
  // 3DS in flight when the hold expires
  const h2 = hold('s6')
  const r = finalize(input(h2, 's6', '3220')) as { threeDs: number }
  db.prepare("UPDATE holds SET expires_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(h2)
  assert.throws(() => approve3ds(r.threeDs, 's6'))
  assert.equal(db.prepare('SELECT status FROM payments WHERE id = ?').get(r.threeDs)!.status, 'declined')
})

test('one_live_ticket blocks a second live ticket on the same inventory row', () => {
  const t = db.prepare('SELECT order_id, inventory_id FROM tickets LIMIT 1').get() as { order_id: number; inventory_id: number }
  assert.throws(() => db.prepare("INSERT INTO tickets (order_id, inventory_id, secret) VALUES (?,?,'x')").run(t.order_id, t.inventory_id))
})

test('order authorization', () => {
  const o = { user_id: null, session_token: 'sess', access_token: 'tok-abc' }
  assert.ok(canViewOrder(o, { userId: null, sessionToken: 'sess' }))
  assert.ok(canViewOrder(o, { userId: null, sessionToken: null, token: 'tok-abc' }))
  assert.ok(!canViewOrder(o, { userId: 5, sessionToken: 'other', token: 'nope' }))
  assert.ok(!canViewOrder({ ...o, user_id: 1 }, { userId: 2, sessionToken: 'sess', token: 'tok-abc' }))
})
