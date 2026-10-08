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
const { createListing, cancelListing, holdListing, activeListings } = await import('../lib/resale.ts')
const { acceptTransfer, cancelTransfer, createTransfer, declineTransfer } = await import('../lib/transfers.ts')
const { scanTicket } = await import('../lib/scan.ts')
const { makeToken } = await import('../lib/safetix.ts')
const { balance } = await import('../lib/ledger.ts')
test.after(() => rmSync(dir, { recursive: true, force: true }))

const run = (sql: string, ...a: (string | number | null)[]) => Number(db.prepare(sql).run(...a).lastInsertRowid)
const get = <T>(sql: string, ...a: (string | number)[]) => db.prepare(sql).get(...a) as T
const org = run("INSERT INTO orgs (name, status) VALUES ('T','approved')")
const city = run("INSERT INTO cities (name, state, lat, lng, tax_rate_bps) VALUES ('X','XX',0,0,1000)")
const venue = run("INSERT INTO venues (org_id, slug, name, address, city_id, lat, lng, tz) VALUES (?, 'v','V','a',?,0,0,'UTC')", org, city)
const sec = run("INSERT INTO sections (venue_id, name, kind, path, label_x, label_y, rank) VALUES (?, 'S', 'reserved', '', 0, 0, 1)", venue)
for (let n = 1; n <= 30; n++) run("INSERT INTO seats (section_id, row, number, x, y) VALUES (?, 'A', ?, 0, 0)", sec, n)
const ev = run("INSERT INTO events (org_id, venue_id, slug, title, category, starts_at, status, onsale_at, ticket_limit) VALUES (?,?, 'e','E','music',?, 'published', ?, 100)", org, venue, new Date(Date.now() + 864e5).toISOString(), new Date(Date.now() - 864e5).toISOString())
for (const n of ['General', 'Premium', 'VIP', 'Accessible']) run('INSERT INTO price_levels (event_id, name, price_cents, ticket_type) VALUES (?,?,5000,?)', ev, n, 'standard')
inv.generateInventory(ev)
const user = (name: string) => run('INSERT INTO users (email, name) VALUES (?,?)', `${name}@x.test`, name)
const [alice, bob, scanner] = [user('alice'), user('bob'), user('scanner')]

let n = 0
// buy `qty` seats as `userId` through the real hold + finalize path; returns ticket ids
function buy(userId: number, qty = 1): number[] {
  const session = `s${++n}`
  const h = inv.holdBestAvailable(ev, { sessionToken: session, userId }, qty)
  const r = finalize({
    holdId: h.holdId, sessionToken: session, userId, email: `u${userId}@x.test`, key: `key-${n}-padding`, method: 'card', brand: 'Visa', last4: '4242', exp: '12/39',
    save: false, billing: { name: 'A', address: 'a', city: 'c', zip: '1' },
  })
  assert.ok('orderId' in r)
  return (db.prepare('SELECT id FROM tickets WHERE order_id = ? ORDER BY id').all(r.orderId) as { id: number }[]).map((t) => t.id)
}
const status = (id: number) => get<{ status: string }>('SELECT status FROM tickets WHERE id = ?', id).status
const secret = (id: number) => get<{ secret: string }>('SELECT secret FROM tickets WHERE id = ?', id).secret
const scan = (id: number) => scanTicket(ev, makeToken(id, secret(id)), scanner).result
const throwsHold = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: Error) => e instanceof inv.HoldError && re.test(e.message))

test('two concurrent buys of one listing: exactly one succeeds', async () => {
  const [t] = buy(alice)
  const listingId = createListing(alice, t, 9000)
  const buyers = [bob, user('carol'), user('dave'), user('erin')]
  const counter = new SharedArrayBuffer(4)
  const results = await Promise.all(
    buyers.map(
      (userId, id) =>
        new Promise<{ id: number; result: string }>((resolve, reject) => {
          const w = new Worker(new URL('./resale.worker.ts', import.meta.url), { workerData: { id, userId, listingId, workers: buyers.length, counter } })
          w.on('message', resolve)
          w.on('error', reject)
        }),
    ),
  )
  assert.equal(results.filter((r) => r.result === 'won').length, 1)
  assert.equal(get<{ n: number }>("SELECT count(*) AS n FROM listings WHERE id = ? AND status = 'sold'", listingId).n, 1)
  assert.equal(status(t), 'resold')
  assert.equal(get<{ n: number }>("SELECT count(*) AS n FROM tickets WHERE inventory_id = (SELECT inventory_id FROM tickets WHERE id = ?) AND status = 'valid'", t).n, 1)
  assert.equal(balance(`user:${alice}`), 8100) // one credit (price - 10% seller fee), not four
})

test('resale: buyer gets a new ticket + secret, old code dies, ledger credited, seller cannot buy own', () => {
  const [t] = buy(alice)
  const oldSecret = secret(t)
  const listingId = createListing(alice, t, 7500)
  assert.equal(status(t), 'listed')
  assert.equal(scan(t), 'invalid') // listed tickets don't scan
  throwsHold(() => holdListing(listingId, { sessionToken: 'alice-s', userId: alice }), /own listing/)
  const before = balance(`user:${alice}`)
  const session = 'bob-resale'
  const h = holdListing(listingId, { sessionToken: session, userId: bob })
  // second buyer can't take it while held
  throwsHold(() => holdListing(listingId, { sessionToken: 'other', userId: null }), /Someone else/)
  throwsHold(() => cancelListing(alice, listingId), /checking out/)
  const r = finalize({ holdId: h.holdId, sessionToken: session, userId: bob, email: 'bob@x.test', key: 'resale-key-padding', method: 'card', brand: 'Visa', last4: '4242', exp: '12/39', save: false, billing: { name: 'B', address: 'a', city: 'c', zip: '1' } })
  assert.ok('orderId' in r)
  const fresh = get<{ id: number; owner_id: number; secret: string }>("SELECT id, owner_id, secret FROM tickets WHERE order_id = ?", (r as { orderId: number }).orderId)
  assert.equal(fresh.owner_id, bob)
  assert.notEqual(fresh.secret, oldSecret)
  assert.equal(status(t), 'resold')
  assert.equal(balance(`user:${alice}`), before + 6750) // 7500 - 10%
  assert.equal(scan(t), 'invalid')
  assert.equal(scan(fresh.id), 'valid')
})

test('expired hold releases the listing lazily; cancel listing restores the ticket', () => {
  const [t] = buy(alice)
  const id = createListing(alice, t, 5000)
  holdListing(id, { sessionToken: 'slow', userId: bob })
  db.prepare('UPDATE listings SET held_until = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), id)
  assert.equal(activeListings(ev, bob).find((l) => l.id === id)!.held, 0)
  holdListing(id, { sessionToken: 'fast', userId: bob }) // takes over
  db.prepare('UPDATE listings SET held_until = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), id)
  cancelListing(alice, id)
  assert.equal(status(t), 'valid')
  throwsHold(() => createListing(alice, t, 0), /above \$0/)
})

test('transfer: pending can be cancelled; accept kills the old QR and issues a new one', () => {
  const [t] = buy(alice)
  throwsHold(() => createTransfer(alice, t, 'alice@x.test'), /yourself/)
  throwsHold(() => createTransfer(bob, t, 'carol@x.test'), /not found/)
  const id = createTransfer(alice, t, 'bob@x.test')
  const { claim_token } = get<{ claim_token: string }>('SELECT claim_token FROM transfers WHERE id = ?', id)
  assert.match(claim_token, /^[0-9a-f]{32}$/)
  throwsHold(() => createTransfer(alice, t, 'carol@x.test'), /pending/)
  throwsHold(() => createListing(alice, t, 1000), /pending transfer/)
  cancelTransfer(alice, id)
  throwsHold(() => acceptTransfer(bob, id, claim_token), /cancelled/)

  const id2 = createTransfer(alice, t, 'bob@x.test')
  const tok2 = get<{ claim_token: string }>('SELECT claim_token FROM transfers WHERE id = ?', id2).claim_token
  const oldToken = makeToken(t, secret(t))
  throwsHold(() => acceptTransfer(bob, id2, 'f'.repeat(32)), /not found/)
  throwsHold(() => acceptTransfer(alice, id2, tok2), /own transfer/)
  const fresh = acceptTransfer(bob, id2, tok2)
  assert.equal(status(t), 'transferred')
  assert.equal(scanTicket(ev, oldToken, scanner).result, 'invalid')
  assert.equal(scan(fresh), 'valid')
  throwsHold(() => createTransfer(alice, t, 'carol@x.test'), /cannot be sent or sold/)
  throwsHold(() => createListing(alice, t, 1000), /cannot be sent or sold/)
})

test('listed tickets cannot be transferred; used and cancelled ones cannot be sent or sold', () => {
  const [a, b, c] = buy(alice, 3)
  createListing(alice, a, 4000)
  throwsHold(() => createTransfer(alice, a, 'bob@x.test'), /listed/)
  assert.equal(scan(b), 'valid')
  throwsHold(() => createListing(alice, b, 4000), /used/)
  throwsHold(() => createTransfer(alice, b, 'bob@x.test'), /used/)
  db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(ev)
  throwsHold(() => createTransfer(alice, c, 'bob@x.test'), /over or cancelled/)
  throwsHold(() => createListing(alice, c, 4000), /over or cancelled/)
  db.prepare("UPDATE events SET status = 'published' WHERE id = ?").run(ev)
})

test('declined transfer leaves the ticket with the sender', () => {
  const [t] = buy(alice)
  const id = createTransfer(alice, t, '+1 555 010 2030')
  const tok = get<{ claim_token: string }>('SELECT claim_token FROM transfers WHERE id = ?', id).claim_token
  declineTransfer(id, tok)
  assert.equal(status(t), 'valid')
  assert.equal(scan(t), 'valid')
})

test('cancel after resale: seller credit reversed once, both orders refunded', async () => {
  const { refundEvent } = await import('../lib/orders.ts')
  const [t] = buy(alice)
  const listingId = createListing(alice, t, 6000)
  const session = 'bob-cancel'
  const h = holdListing(listingId, { sessionToken: session, userId: bob })
  const r = finalize({ holdId: h.holdId, sessionToken: session, userId: bob, email: 'bob@x.test', key: 'cancel-key-padding', method: 'card', brand: 'Visa', last4: '4242', exp: '12/39', save: false, billing: { name: 'B', address: 'a', city: 'c', zip: '1' } })
  assert.ok('orderId' in r)
  const seller = () => get<{ s: number }>("SELECT coalesce(sum(amount), 0) AS s FROM ledger WHERE account = ? AND ref LIKE ?", `user:${alice}`, `listing:${listingId}%`).s
  const all = () => get<{ s: number }>("SELECT coalesce(sum(amount), 0) AS s FROM ledger WHERE ref LIKE ?", `listing:${listingId}%`).s
  assert.equal(seller(), 5400) // 6000 - 10% seller fee
  refundEvent(ev)
  assert.equal(seller(), 0) // the net credit is reversed
  assert.equal(all(), 0)
  assert.equal(get<{ n: number }>("SELECT count(*) AS n FROM ledger WHERE ref = ? AND account = 'platform'", `listing:${listingId}:reversal`).n, 2) // platform fee rows reversed too
  refundEvent(ev) // idempotent
  assert.equal(seller(), 0)
  assert.equal(get<{ s: number }>('SELECT sum(amount) AS s FROM ledger').s, 0) // zero-sum
  const orders = [get<{ order_id: number }>('SELECT order_id FROM tickets WHERE id = ?', t).order_id, r.orderId]
  for (const o of orders) assert.equal(get<{ status: string }>('SELECT status FROM orders WHERE id = ?', o).status, 'refunded')
})
