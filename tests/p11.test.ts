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
const { finalize } = await import('../lib/orders.ts')
const { createListing, updateListing, expireListings, holdListing, faceOf } = await import('../lib/resale.ts')
const { createTransfer, acceptTransfer, expireTransfers } = await import('../lib/transfers.ts')
const { setResaleRule, setTransferRule } = await import('../lib/rules.ts')
const { balance, ledgerTotal } = await import('../lib/ledger.ts')
const { requestPayout, decidePayout } = await import('../lib/payouts.ts')
test.after(() => rmSync(dir, { recursive: true, force: true }))

const run = (sql: string, ...a: (string | number | null)[]) => Number(db.prepare(sql).run(...a).lastInsertRowid)
const get = <T>(sql: string, ...a: (string | number)[]) => db.prepare(sql).get(...a) as T
const org = run("INSERT INTO orgs (name, status) VALUES ('T','approved')")
const city = run("INSERT INTO cities (name, state, lat, lng, tax_rate_bps) VALUES ('X','XX',0,0,1000)")
const venue = run("INSERT INTO venues (org_id, slug, name, address, city_id, lat, lng, tz) VALUES (?, 'v','V','a',?,0,0,'UTC')", org, city)
const sec = run("INSERT INTO sections (venue_id, name, kind, path, label_x, label_y, rank) VALUES (?, 'S', 'reserved', '', 0, 0, 1)", venue)
for (let n = 1; n <= 30; n++) run("INSERT INTO seats (section_id, row, number, x, y) VALUES (?, 'A', ?, 0, 0)", sec, n)
const mkEvent = (slug: string, startsInMs: number) => {
  const ev = run("INSERT INTO events (org_id, venue_id, slug, title, category, starts_at, status, onsale_at, ticket_limit) VALUES (?,?,?,?,'music',?, 'published', ?, 100)", org, venue, slug, slug, new Date(Date.now() + startsInMs).toISOString(), new Date(Date.now() - 864e5).toISOString())
  for (const n of ['General', 'Premium', 'VIP', 'Accessible']) run('INSERT INTO price_levels (event_id, name, price_cents, ticket_type) VALUES (?,?,5000,?)', ev, n, 'standard')
  inv.generateInventory(ev)
  return ev
}
const ev = mkEvent('e1', 5 * 864e5)
const user = (name: string) => run('INSERT INTO users (email, name) VALUES (?,?)', `${name}@x.test`, name)
const [alice, bob, admin] = [user('alice'), user('bob'), user('admin')]

let n = 0
function buy(userId: number, event = ev, qty = 1): number[] {
  const session = `s${++n}`
  const h = inv.holdBestAvailable(event, { sessionToken: session, userId }, qty)
  const r = finalize({ holdId: h.holdId, sessionToken: session, userId, email: `u${userId}@x.test`, key: `key-${n}-padding`, method: 'card', brand: 'Visa', last4: '4242', exp: '12/39', save: false, billing: { name: 'A', address: 'a', city: 'c', zip: '1' } })
  assert.ok('orderId' in r)
  return (db.prepare('SELECT id FROM tickets WHERE order_id = ? ORDER BY id').all(r.orderId) as { id: number }[]).map((t) => t.id)
}
const throwsHold = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: Error) => e instanceof inv.HoldError && re.test(e.message))

test('listing above the ceiling (or below the floor) is rejected; edit re-validates', () => {
  const [t] = buy(alice)
  assert.equal(faceOf(t), 5000)
  setResaleRule(ev, { enabled: 'on', min_pct: 50, max_pct: 150, seller_fee_pct: 10, buyer_fee_pct: 5 })
  throwsHold(() => createListing(alice, t, 7501), /between \$25\.00 and \$75\.00/)
  throwsHold(() => createListing(alice, t, 2499), /between/)
  const id = createListing(alice, t, 7500)
  throwsHold(() => updateListing(alice, id, 9000), /between/)
  updateListing(alice, id, 6000)
  assert.equal(get<{ price_cents: number }>('SELECT price_cents FROM listings WHERE id = ?', id).price_cents, 6000)
  throwsHold(() => updateListing(bob, id, 6000), /not found/)
  setResaleRule(ev, { enabled: '', min_pct: 0, max_pct: 300, seller_fee_pct: 10, buyer_fee_pct: 5 }) // resale off
  throwsHold(() => createListing(alice, buy(alice)[0], 5000), /turned off/)
  setResaleRule(ev, {} as never, true) // back to the defaults
})

test('seller net credit after resale, buyer fee in the order items, ledger zero-sum, reversal on cancel', async () => {
  const { refundEvent } = await import('../lib/orders.ts')
  const [t] = buy(alice)
  const before = balance(`user:${alice}`)
  const lid = createListing(alice, t, 10000)
  const h = holdListing(lid, { sessionToken: 'bob-s', userId: bob })
  const r = finalize({ holdId: h.holdId, sessionToken: 'bob-s', userId: bob, email: 'bob@x.test', key: 'p11-resale-key', method: 'card', brand: 'Visa', last4: '4242', exp: '12/39', save: false, billing: { name: 'B', address: 'a', city: 'c', zip: '1' } })
  assert.ok('orderId' in r)
  assert.equal(balance(`user:${alice}`) - before, 9000) // price - 10%
  const o = get<{ total: number; source: string }>('SELECT total, source FROM orders WHERE id = ?', (r as { orderId: number }).orderId)
  assert.equal(o.source, 'resale')
  assert.equal(o.total, 10000 + 500 + 1050) // price + 5% buyer fee + 10% tax on both
  assert.equal(get<{ s: number }>('SELECT sum(unit_cents + fee_cents + tax_cents) AS s FROM order_items WHERE order_id = ?', (r as { orderId: number }).orderId).s, o.total)
  assert.equal(get<{ s: number }>("SELECT sum(amount) AS s FROM ledger WHERE account = 'platform' AND ref = ?", `listing:${lid}`).s, 1000 + 500)
  assert.equal(ledgerTotal(), 0)
  refundEvent(ev)
  assert.equal(balance(`user:${alice}`), before) // net credit reversed
  assert.equal(ledgerTotal(), 0)
})

test('payout: request reserves funds, reject returns them, mark paid empties; ledger stays zero-sum', () => {
  const acct = `user:${alice}`
  run("INSERT INTO ledger (account, kind, amount, ref) VALUES ('cash','sale',-5000,'t'), (?, 'resale_credit', 5000, 't')", acct)
  const b = balance(acct)
  assert.throws(() => requestPayout(acct, alice, b + 1), /at most/)
  const p1 = requestPayout(acct, alice, b)
  assert.equal(balance(acct), 0)
  assert.throws(() => requestPayout(acct, alice, 1), /at most/)
  decidePayout(p1, admin, false)
  assert.equal(balance(acct), b)
  assert.throws(() => decidePayout(p1, admin, true), /already decided/)
  const p2 = requestPayout(acct, alice, b)
  decidePayout(p2, admin, true)
  assert.equal(balance(acct), 0)
  assert.equal(get<{ s: number }>("SELECT sum(amount) AS s FROM ledger WHERE account = 'payouts'").s, 0)
  assert.equal(ledgerTotal(), 0)
})

test('payout requests cannot overdraw under concurrency', async () => {
  const acct = `user:${bob}`
  run("INSERT INTO ledger (account, kind, amount, ref) VALUES ('cash','sale',-10000,'c'), (?, 'resale_credit', 10000, 'c')", acct)
  const counter = new SharedArrayBuffer(4)
  const res = await Promise.all(
    Array.from({ length: 6 }, () => new Promise<{ ok: boolean }>((resolve, reject) => {
      const w = new Worker(new URL('./p11.worker.ts', import.meta.url), { workerData: { account: acct, userId: bob, amount: 10000, workers: 6, counter } })
      w.on('message', resolve)
      w.on('error', reject)
    })),
  )
  assert.equal(res.filter((r) => r.ok).length, 1)
  assert.equal(balance(acct), 0)
})

test('transfer past the deadline is rejected at create and at accept; disabled blocks; job expires pending', () => {
  const ev2 = mkEvent('e2', 30 * 3_600_000) // starts in 30h
  const [t1, t2] = buy(alice, ev2, 2)
  setTransferRule(ev2, true, 48) // deadline 48h before: already closed
  throwsHold(() => createTransfer(alice, t1, 'bob@x.test'), /closed 48 hours/)
  setTransferRule(ev2, true, 24) // closes in 6h
  const id = createTransfer(alice, t1, 'bob@x.test')
  const tok = get<{ claim_token: string }>('SELECT claim_token FROM transfers WHERE id = ?', id).claim_token
  setTransferRule(ev2, true, 36) // deadline passes before bob accepts
  throwsHold(() => acceptTransfer(bob, id, tok), /closed 36 hours/)
  assert.equal(expireTransfers(), 1) // the job expires it (deadline passed)
  assert.equal(get<{ status: string }>('SELECT status FROM transfers WHERE id = ?', id).status, 'expired')
  assert.equal(get<{ n: number }>("SELECT count(*) AS n FROM notifications WHERE user_id = ? AND title LIKE '%expired%'", alice).n, 1)
  setTransferRule(ev2, false, '')
  throwsHold(() => createTransfer(alice, t2, 'bob@x.test'), /turned off/)
  // a pending transfer older than its 7 days expires too
  setTransferRule(ev2, true, '')
  const id2 = createTransfer(alice, t2, 'bob@x.test')
  db.prepare('UPDATE transfers SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), id2)
  assert.equal(expireTransfers(), 1)
  assert.equal(expireTransfers(), 0) // idempotent
})

test('listings expire at event start: job sets expired and the ticket is valid again', () => {
  const [t] = buy(alice, mkEvent('e3', 5 * 864e5))
  const lid = createListing(alice, t, 5000)
  assert.equal(expireListings(), 0)
  db.prepare('UPDATE listings SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), lid)
  assert.equal(expireListings(), 1)
  assert.equal(get<{ status: string }>('SELECT status FROM listings WHERE id = ?', lid).status, 'expired')
  assert.equal(get<{ status: string }>('SELECT status FROM tickets WHERE id = ?', t).status, 'valid')
})
