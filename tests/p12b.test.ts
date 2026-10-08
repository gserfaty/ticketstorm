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
const { cancelListing, createListing, holdListing, suggestPrice, updateListing } = await import('../lib/resale.ts')
const offers = await import('../lib/offers.ts')
const { balance, ledgerTotal } = await import('../lib/ledger.ts')
test.after(() => rmSync(dir, { recursive: true, force: true }))

const run = (sql: string, ...a: (string | number | null)[]) => Number(db.prepare(sql).run(...a).lastInsertRowid)
const get = <T>(sql: string, ...a: (string | number)[]) => db.prepare(sql).get(...a) as T
const org = run("INSERT INTO orgs (name, status) VALUES ('T','approved')")
const city = run("INSERT INTO cities (name, state, lat, lng, tax_rate_bps) VALUES ('X','XX',0,0,1000)")
const venue = run("INSERT INTO venues (org_id, slug, name, address, city_id, lat, lng, tz) VALUES (?, 'v','V','a',?,0,0,'UTC')", org, city)
const sec = run("INSERT INTO sections (venue_id, name, kind, path, label_x, label_y, rank) VALUES (?, 'S', 'reserved', '', 0, 0, 1)", venue)
for (let n = 1; n <= 40; n++) run("INSERT INTO seats (section_id, row, number, x, y) VALUES (?, 'A', ?, 0, 0)", sec, n)
const mkEvent = (slug: string, resale = '{"min_pct":50,"max_pct":200}') => {
  const ev = run("INSERT INTO events (org_id, venue_id, slug, title, category, starts_at, status, onsale_at, ticket_limit, resale_rule) VALUES (?,?,?,?,'music',?, 'published', ?, 100, ?)", org, venue, slug, slug, new Date(Date.now() + 864e5).toISOString(), new Date(Date.now() - 864e5).toISOString(), resale)
  for (const n of ['General', 'Premium', 'VIP', 'Accessible']) run('INSERT INTO price_levels (event_id, name, price_cents, ticket_type) VALUES (?,?,5000,?)', ev, n, 'standard')
  inv.generateInventory(ev)
  return ev
}
const ev = mkEvent('e')
const user = (name: string) => run('INSERT INTO users (email, name) VALUES (?,?)', `${name}@x.test`, name)
let n = 0
const card = { method: 'card' as const, brand: 'Visa', last4: '4242', exp: '12/39', save: false, billing: { name: 'A', address: 'a', city: 'c', zip: '1' } }
function buy(event: number, userId: number, qty = 1, extra: Record<string, unknown> = {}) {
  const session = `s${++n}`
  const h = inv.holdBestAvailable(event, { sessionToken: session, userId }, qty)
  const r = finalize({ holdId: h.holdId, sessionToken: session, userId, email: `u${userId}@x.test`, key: `key-${n}-padding`, ...card, ...extra })
  assert.ok('orderId' in r)
  return { orderId: r.orderId, tickets: (db.prepare('SELECT id FROM tickets WHERE order_id = ? ORDER BY id').all(r.orderId) as { id: number }[]).map((t) => t.id) }
}
const throwsHold = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: Error) => e instanceof inv.HoldError && re.test(e.message))

test('offer accept race: several offers on one listing, exactly one accept wins and the rest are declined', async () => {
  const seller = user('seller1')
  const [t] = buy(ev, seller).tickets
  const listingId = createListing(seller, t, 8000)
  const buyers = [user('b1'), user('b2'), user('b3')]
  const ids = buyers.map((b, i) => offers.makeOffer(b, listingId, 6000 + i * 100))
  throwsHold(() => offers.makeOffer(buyers[0], listingId, 6500), /already have a pending offer/)
  throwsHold(() => offers.makeOffer(buyers[0], listingId, 8000), /below the asking price/)
  throwsHold(() => offers.makeOffer(seller, listingId, 100), /own listing/)
  throwsHold(() => offers.makeOffer(user('cheap'), listingId, 1000), /at least \$25\.00/) // floor = 50% of the $50 face
  const counter = new SharedArrayBuffer(4)
  const results = await Promise.all(
    ids.map((offerId, id) => new Promise<{ id: number; result: string }>((resolve, reject) => {
      const w = new Worker(new URL('./offers.worker.ts', import.meta.url), { workerData: { id, sellerId: seller, offerId, workers: ids.length, counter } })
      w.on('message', resolve)
      w.on('error', reject)
    })),
  )
  assert.equal(results.filter((r) => r.result === 'won').length, 1)
  const l = get<{ reserved_for: number; offer_price_cents: number }>('SELECT reserved_for, offer_price_cents FROM listings WHERE id = ?', listingId)
  const winner = get<{ buyer_id: number; price_cents: number }>("SELECT buyer_id, price_cents FROM resale_offers WHERE listing_id = ? AND status = 'accepted'", listingId)
  assert.equal(l.reserved_for, winner.buyer_id)
  assert.equal(l.offer_price_cents, winner.price_cents)
  assert.equal(get<{ n: number }>("SELECT count(*) AS n FROM resale_offers WHERE listing_id = ? AND status = 'rejected'", listingId).n, 2)
  // a second accept of an already answered offer fails, and the seller cannot edit or cancel while reserved
  throwsHold(() => offers.acceptOffer(seller, ids[0]), /not found or already answered/)
})

test('accepted offer reserves the listing for that buyer at the offer price; checkout and ledger use it', () => {
  const seller = user('seller2')
  const [t] = buy(ev, seller).tickets
  const listingId = createListing(seller, t, 9000)
  const winner = user('w2')
  const other = user('o2')
  const oid = offers.makeOffer(winner, listingId, 6000)
  offers.acceptOffer(seller, oid)
  // nobody else can hold it, and the seller cannot cancel it
  throwsHold(() => holdListing(listingId, { sessionToken: 'x1', userId: other }), /Someone else is buying/)
  throwsHold(() => holdListing(listingId, { sessionToken: 'x2', userId: null }), /Someone else is buying/)
  throwsHold(() => cancelListing(seller, listingId), /buyer is checking out/)
  throwsHold(() => updateListing(seller, listingId, 8000), /buyer is checking out/)
  const session = 'w2s'
  const { holdId } = holdListing(listingId, { sessionToken: session, userId: winner })
  const r = finalize({ holdId, sessionToken: session, userId: winner, email: 'w2@x.test', key: 'offer-key-padding', ...card })
  assert.ok('orderId' in r)
  const o = get<{ subtotal: number; total: number }>('SELECT subtotal, total FROM orders WHERE id = ?', r.orderId)
  assert.equal(o.subtotal, 6000) // the offer price, not the asking price
  assert.equal(get<{ s: number }>("SELECT sum(unit_cents) AS s FROM order_items WHERE order_id = ? AND kind = 'ticket'", r.orderId).s, 6000)
  assert.equal(get<{ s: number }>('SELECT sum(unit_cents + fee_cents + tax_cents) AS s FROM order_items WHERE order_id = ?', r.orderId).s, o.total)
  assert.equal(balance(`user:${seller}`), 6000 - 600) // price minus the 10% seller fee
  assert.equal(ledgerTotal(), 0)
  assert.equal(get<{ status: string }>('SELECT status FROM resale_offers WHERE id = ?', oid).status, 'completed')
})

test('a lapsed reservation frees the listing at its asking price again', () => {
  const seller = user('seller3')
  const [t] = buy(ev, seller).tickets
  const listingId = createListing(seller, t, 9000)
  const b = user('b3x')
  const oid = offers.makeOffer(b, listingId, 5000)
  offers.acceptOffer(seller, oid)
  db.prepare('UPDATE listings SET reserved_until = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), listingId)
  const { holdId } = holdListing(listingId, { sessionToken: 'z1', userId: user('z') })
  const q = get<{ p: number }>('SELECT l.price_cents AS p FROM listings l WHERE l.id = ?', listingId)
  assert.equal(q.p, 9000)
  assert.equal(get<{ reserved_for: number | null }>('SELECT reserved_for FROM listings WHERE id = ?', listingId).reserved_for, null)
  assert.ok(holdId > 0)
})

test('price suggestion is the median of the other active listings in the section, within floor and ceiling', () => {
  const e2 = mkEvent('e2')
  const sellers = [user('m1'), user('m2'), user('m3'), user('m4')]
  const tickets = sellers.map((s) => buy(e2, s).tickets[0])
  createListing(sellers[0], tickets[0], 6000)
  createListing(sellers[1], tickets[1], 8000)
  createListing(sellers[2], tickets[2], 10000)
  const s = suggestPrice(tickets[3], sellers[3])!
  assert.equal(s.cents, 8000)
  assert.equal(s.n, 3)
  assert.equal(suggestPrice(tickets[0], sellers[0])!.cents, 9000) // median of 8000 and 10000, others only
})
