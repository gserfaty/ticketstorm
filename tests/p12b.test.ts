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
const { refundOrder, approve3ds } = await import('../lib/orders.ts')
const { purchaseGift, findGift, redeemToCredit, newCode } = await import('../lib/giftcards.ts')
const { creditBalance, spendCredit, addCredit } = await import('../lib/stored.ts')
const { resolveDispute } = await import('../lib/disputes.ts')
const { settleEvent } = await import('../lib/reports.ts')
const rev = await import('../lib/reviews.ts')
const { runDigest, isoWeek } = await import('../lib/digest.ts')
const { importArtists } = await import('../lib/favorites.ts')
const ab = await import('../lib/ab.ts')
const i18n = await import('../lib/i18n.ts')
const account = await import('../lib/account.ts')
const analytics = await import('../lib/analytics.ts')
const dev = await import('../lib/devtools.ts')
const orgTools = await import('../lib/organizer.ts')
const { customersCsv } = await import('../lib/reports.ts')
const { scanTicket } = await import('../lib/scan.ts')
const { makeToken } = await import('../lib/safetix.ts')
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

const sum = (sql: string, ...a: (string | number)[]) => get<{ s: number | null }>(sql, ...a).s ?? 0
const payRows = (orderId: number) => db.prepare('SELECT kind, method, amount, status FROM payments WHERE order_id = ? ORDER BY id').all(orderId) as { kind: string; method: string; amount: number; status: string }[]
function giftWith(buyer: number, cents: number): string {
  purchaseGift(buyer, { amount: cents, recipient: 'gift@x.test', message: 'hi', number: '4242424242424242', exp: '12/39', cvc: '123' })
  const mail = get<{ body: string }>("SELECT body FROM outbox WHERE \"to\" = 'gift@x.test' ORDER BY id DESC LIMIT 1")
  return /Your gift card code: ([A-Z0-9-]+)/.exec(mail.body)![1]
}
const itemsSum = (orderId: number) => sum('SELECT sum(unit_cents + fee_cents + tax_cents) AS s FROM order_items WHERE order_id = ?', orderId)

test('gift card: partial payment charges the card the remainder, and a refund returns the gift part to the card', () => {
  const buyer = user('gbuyer')
  const code = giftWith(buyer, 2000)
  assert.match(code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/)
  assert.equal(get<{ code_hash: string }>('SELECT code_hash FROM gift_cards ORDER BY id DESC LIMIT 1').code_hash.includes(code.slice(0, 4)), false) // hashed at rest
  assert.equal(findGift(code)!.balance, 2000)
  assert.equal(findGift('AAAA-AAAA-AAAA-AAAA'), undefined)
  const { orderId } = buy(ev, buyer, 1, { giftCode: code })
  const rows = payRows(orderId)
  const total = get<{ total: number }>('SELECT total FROM orders WHERE id = ?', orderId).total
  assert.deepEqual(rows.map((r) => [r.method, r.amount]), [['card', total - 2000], ['giftcard', 2000]])
  assert.equal(sum("SELECT sum(amount) AS s FROM payments WHERE order_id = ? AND kind = 'charge'", orderId), total)
  assert.equal(itemsSum(orderId), total)
  assert.equal(findGift(code)!.balance, 0)
  assert.equal(ledgerTotal(), 0)
  refundOrder(orderId, { reason: 'test' })
  const refunds = payRows(orderId).filter((r) => r.kind === 'refund')
  assert.deepEqual(refunds.map((r) => [r.method, r.amount]).sort(), [['card', total - 2000], ['giftcard', 2000]].sort())
  assert.equal(findGift(code)!.balance, 2000) // the gift part is back on the card
  assert.equal(ledgerTotal(), 0)
  // a gift card covering the whole total takes no card at all
  const big = giftWith(buyer, 50_000)
  const full = buy(ev, buyer, 1, { giftCode: big, last4: '0002' }) // a declining card is never touched
  assert.deepEqual(payRows(full.orderId).map((r) => r.method), ['giftcard', 'giftcard']) // the 0-cent main row and the gift card row; the card is never charged
  assert.equal(payRows(full.orderId).filter((r) => r.amount > 0).every((r) => r.method === 'giftcard'), true)
  assert.equal(ledgerTotal(), 0)
})

test('gift card balance can never be overspent: a second 3-D Secure order using the same card is refused when approved', () => {
  const buyer = user('gbuyer2')
  const code = giftWith(buyer, 3000)
  const open3ds = (key: string) => {
    const session = `g3-${key}`
    const h = inv.holdBestAvailable(ev, { sessionToken: session, userId: buyer }, 1)
    const r = finalize({ holdId: h.holdId, sessionToken: session, userId: buyer, email: 'g@x.test', key, ...card, last4: '3220', giftCode: code })
    assert.ok('threeDs' in r)
    return { session, paymentId: (r as { threeDs: number }).threeDs }
  }
  const a = open3ds('g3-key-aaaaaaaa')
  const b = open3ds('g3-key-bbbbbbbb')
  assert.ok('orderId' in approve3ds(a.paymentId, a.session))
  throwsHold(() => approve3ds(b.paymentId, b.session), /gift card balance changed/)
  assert.equal(findGift(code)!.balance, 0)
  assert.equal(get<{ n: number }>("SELECT count(*) AS n FROM gift_cards WHERE balance_cents < 0").n, 0)
  assert.equal(ledgerTotal(), 0)
})

test('account credit: spending is atomic and never exceeds the balance; refund as credit is applied at checkout', () => {
  const u = user('creditor')
  addCredit(u, 1000, 'test')
  assert.equal(spendCredit(u, 1000, 'a'), true)
  assert.equal(spendCredit(u, 1, 'b'), false)
  assert.equal(creditBalance(u), 0)
  // refund an order as credit
  const { orderId } = buy(ev, u)
  const total = get<{ total: number }>('SELECT total FROM orders WHERE id = ?', orderId).total
  refundOrder(orderId, { reason: 'test', credit: true })
  assert.equal(creditBalance(u), total)
  assert.deepEqual(payRows(orderId).filter((r) => r.kind === 'refund').map((r) => r.method), ['credit'])
  assert.equal(ledgerTotal(), 0)
  // credit pays first, the card pays the rest; sum(items) == total still
  const o2 = buy(ev, u, 2, { useCredit: true })
  const t2 = get<{ total: number }>('SELECT total FROM orders WHERE id = ?', o2.orderId).total
  assert.equal(creditBalance(u), 0)
  assert.deepEqual(payRows(o2.orderId).map((r) => [r.method, r.amount]), [['card', t2 - total], ['credit', total]])
  assert.equal(itemsSum(o2.orderId), t2)
  assert.equal(ledgerTotal(), 0)
  // refunding that order returns the credit part to credit and the rest to the card
  refundOrder(o2.orderId, { reason: 'test' })
  assert.equal(creditBalance(u), total)
  assert.equal(ledgerTotal(), 0)
  // credit never goes past what is owed: a small balance on a big order
  const o3 = buy(ev, u, 1, { useCredit: true })
  assert.equal(creditBalance(u), Math.max(total - get<{ total: number }>('SELECT total FROM orders WHERE id = ?', o3.orderId).total, 0))
  // redeeming a gift card to credit is single use
  const code = giftWith(u, 1500)
  const before = creditBalance(u)
  assert.equal(redeemToCredit(u, code), 1500)
  assert.throws(() => redeemToCredit(u, code), /no balance/)
  assert.equal(creditBalance(u), before + 1500)
  assert.equal(ledgerTotal(), 0)
})

test('chargeback lost: the order is refunded by a forced payment, tickets die, ledger stays zero-sum (before and after settlement)', () => {
  const e3 = mkEvent('e3')
  const u = user('disputer')
  const a = buy(e3, u, 2, { last4: '0259' })
  const d = get<{ id: number; status: string; amount: number }>('SELECT id, status, amount FROM disputes WHERE order_id = ?', a.orderId)
  assert.equal(d.status, 'open')
  const admin = user('admin1')
  // a normal refund of this card fails; the chargeback cannot
  resolveDispute(admin, d.id, 'lost', 'bank won')
  const ref = payRows(a.orderId).filter((r) => r.kind === 'refund')
  assert.deepEqual(ref.map((r) => [r.method, r.status]), [['chargeback', 'succeeded']])
  assert.equal(get<{ status: string }>('SELECT status FROM orders WHERE id = ?', a.orderId).status, 'refunded')
  assert.equal(sum("SELECT count(*) AS s FROM tickets WHERE order_id = ? AND status = 'cancelled'", a.orderId), 2)
  assert.equal(sum("SELECT count(*) AS s FROM inventory WHERE id IN (SELECT inventory_id FROM tickets WHERE order_id = ?) AND status = 'available'", a.orderId), 2)
  throwsHold(() => { try { resolveDispute(admin, d.id, 'won', '') } catch (e) { throw new inv.HoldError(String((e as Error).message), 400) } }, /already decided/)
  assert.equal(ledgerTotal(), 0)
  // won: nothing moves
  const b = buy(e3, u, 1, { last4: '0259' })
  const db2 = get<{ id: number }>('SELECT id FROM disputes WHERE order_id = ?', b.orderId)
  resolveDispute(admin, db2.id, 'won', 'evidence ok')
  assert.equal(get<{ status: string }>('SELECT status FROM orders WHERE id = ?', b.orderId).status, 'paid')
  // lost AFTER settlement: reversed out of organizer / platform / tax, still zero-sum
  const c = buy(e3, u, 1, { last4: '0259' })
  db.prepare('UPDATE orders SET status = status WHERE id = ?').run(c.orderId)
  db.prepare("UPDATE events SET starts_at = ? WHERE id = ?").run(new Date(Date.now() - 864e5).toISOString(), e3)
  // the open dispute on b stays paid; settle needs no orders in review
  settleEvent(e3, admin)
  assert.equal(ledgerTotal(), 0)
  const orgBefore = balance(`org:${org}`)
  resolveDispute(admin, get<{ id: number }>('SELECT id FROM disputes WHERE order_id = ?', c.orderId).id, 'lost', '')
  assert.ok(balance(`org:${org}`) < orgBefore)
  assert.equal(ledgerTotal(), 0)
})

test('reviews: only verified attendees (a scanned ticket) can review, once per target, shown after approval', () => {
  const e4 = mkEvent('e4')
  const att = user('attendee')
  const stranger = user('stranger')
  const admin = user('admin2')
  const { tickets: [t] } = buy(e4, att)
  assert.throws(() => rev.submitReview(att, 'event', e4, 5, 'bought but not scanned'), /Only people who attended/)
  assert.throws(() => rev.submitReview(stranger, 'event', e4, 5, 'never went'), /Only people who attended/)
  const secret = get<{ secret: string }>('SELECT secret FROM tickets WHERE id = ?', t).secret
  assert.equal(scanTicket(e4, makeToken(t, secret), admin).result, 'valid')
  assert.throws(() => rev.submitReview(att, 'event', e4, 6, 'x'), /1 to 5/)
  assert.throws(() => rev.submitReview(att, 'event', e4, 4, ''), /Write a review/)
  const id = rev.submitReview(att, 'event', e4, 4, '<script>alert(1)</script> loved it')
  assert.throws(() => rev.submitReview(att, 'event', e4, 5, 'again'), /already reviewed/)
  assert.deepEqual(rev.approvedReviews('event', e4).list, []) // pending: not public
  rev.decideReview(admin, id, true)
  assert.equal(rev.approvedReviews('event', e4).list.length, 1)
  assert.throws(() => rev.decideReview(admin, id, false), /already decided/)
  // the scanned ticket also makes the attendee a verified visitor of the venue; the stranger is still refused
  assert.ok(rev.submitReview(att, 'venue', venue, 5, 'nice venue'))
  assert.throws(() => rev.submitReview(stranger, 'venue', venue, 5, 'x'), /Only people who attended/)
})

test('weekly digest is sent once per user per ISO week and honours marketing preferences', () => {
  const e5 = mkEvent('e5')
  assert.ok(e5)
  const a = user('dig-a')
  const b = user('dig-b')
  const c = user('dig-c')
  db.prepare('UPDATE users SET notif_prefs = ? WHERE id = ?').run(JSON.stringify({ marketing_email: true }), a)
  db.prepare('UPDATE users SET notif_prefs = ? WHERE id = ?').run(JSON.stringify({ marketing_inapp: false, marketing_email: false }), c)
  const when = new Date('2031-03-05T10:00:00Z')
  assert.equal(isoWeek(new Date('2027-01-03T00:00:00Z')), '2026-W53')
  assert.equal(isoWeek(when), '2031-W10')
  const mails = () => get<{ n: number }>("SELECT count(*) AS n FROM outbox WHERE subject = 'Your weekly TicketStorm digest' AND \"to\" = 'dig-a@x.test'").n
  runDigest(when)
  const first = mails()
  assert.equal(first, 1)
  const body = get<{ body: string }>("SELECT body FROM outbox WHERE \"to\" = 'dig-a@x.test' AND subject = 'Your weekly TicketStorm digest'").body
  assert.match(body, /Unsubscribe from these emails/)
  runDigest(when)
  runDigest(new Date(when.getTime() + 86_400_000)) // same ISO week
  assert.equal(mails(), 1)
  assert.equal(get<{ n: number }>("SELECT count(*) AS n FROM notifications WHERE user_id = ? AND kind = 'digest'", a).n, 1)
  // b has marketing email off by default: in-app only; c switched both off: nothing at all
  assert.equal(get<{ n: number }>("SELECT count(*) AS n FROM outbox WHERE \"to\" = 'dig-b@x.test' AND subject LIKE '%digest%'").n, 0)
  assert.equal(get<{ n: number }>("SELECT count(*) AS n FROM notifications WHERE user_id = ? AND kind = 'digest'", b).n, 1)
  assert.equal(get<{ n: number }>("SELECT count(*) AS n FROM notifications WHERE user_id = ? AND kind = 'digest'", c).n, 0)
  runDigest(new Date(when.getTime() + 7 * 86_400_000)) // next week: one more
  assert.equal(mails(), 2)
})

test('import artists matches names ignoring case and punctuation and reports the rest', () => {
  const u = user('importer')
  run("INSERT INTO artists (slug, name) VALUES ('the-neon-band', 'The Neon Band')")
  run("INSERT INTO artists (slug, name) VALUES ('ac-dc-ish', 'AC/DC-ish & Co')")
  const r = importArtists(u, 'neon band\nAC DC ish and co\nNobody We Know\nneon band')
  assert.deepEqual(r.added.sort(), ['AC/DC-ish & Co', 'The Neon Band'])
  assert.deepEqual(r.unmatched, ['Nobody We Know'])
  assert.deepEqual(importArtists(u, 'The Neon Band').already, ['The Neon Band'])
  assert.equal(get<{ n: number }>("SELECT count(*) AS n FROM favorites WHERE user_id = ? AND kind = 'artist'", u).n, 2)
})

test('API keys: random, shown once, stored only as a hash; 401 without a valid key; scoped to the key organization; revocable; rate limited', () => {
  const owner = user('apiowner')
  const otherOrg = run("INSERT INTO orgs (name, status) VALUES ('Other','approved')")
  const otherVenue = run("INSERT INTO venues (org_id, slug, name, address, city_id, lat, lng, tz) VALUES (?, 'ov','OV','a',?,0,0,'UTC')", otherOrg, city)
  run("INSERT INTO events (org_id, venue_id, slug, title, category, starts_at, status) VALUES (?,?, 'other-org-event','Other org event','music',?, 'published')", otherOrg, otherVenue, new Date(Date.now() + 864e5).toISOString())
  const key = dev.createApiKey(org, 'site', owner)
  assert.match(key, /^tsk_[0-9a-f]{48}$/)
  const row = get<{ key_hash: string; prefix: string }>('SELECT key_hash, prefix FROM api_keys ORDER BY id DESC LIMIT 1')
  assert.notEqual(row.key_hash, key)
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM api_keys').all()).includes(key.slice(8)))
  assert.equal(dev.authenticateKey(null), undefined)
  assert.equal(dev.authenticateKey('Bearer nope'), undefined)
  assert.equal(dev.authenticateKey(`Bearer tsk_${'0'.repeat(48)}`), undefined)
  const auth = dev.authenticateKey(`Bearer ${key}`)!
  assert.equal(auth.orgId, org)
  const titles = dev.apiEvents(auth.orgId).map((e) => e.slug)
  assert.ok(titles.includes('e') && !titles.includes('other-org-event'))
  const json = JSON.stringify(dev.apiEvents(auth.orgId))
  assert.ok(!/@|email|user_id|buyer/i.test(json), 'no personal data in the API output')
  for (let i = 0; i < dev.API_LIMIT; i++) assert.ok(dev.apiAllowed(auth.keyId))
  assert.equal(dev.apiAllowed(auth.keyId), false)
  dev.revokeApiKey(org, auth.keyId)
  assert.equal(dev.authenticateKey(`Bearer ${key}`), undefined)
  assert.throws(() => dev.revokeApiKey(otherOrg, auth.keyId), /not found/) // another org cannot touch this key
})

test('webhooks: signed with HMAC over the exact body, org-scoped, logged to the outbox webhook channel with no personal data', () => {
  const org2 = run("INSERT INTO orgs (name, status) VALUES ('Hooks','approved')")
  dev.addWebhook(org2, 'https://example.com/hook')
  assert.throws(() => dev.addWebhook(org2, 'javascript:alert(1)'), /http\(s\) URL/)
  const secret = get<{ secret: string }>('SELECT secret FROM webhooks WHERE org_id = ?', org2).secret
  // an order for an event of the ORIGINAL org emits nothing to org2's hook
  buy(ev, user('hookbuyer'))
  assert.equal(get<{ n: number }>("SELECT count(*) AS n FROM outbox WHERE channel = 'webhook'").n, 0)
  dev.emitWebhook(org2, 'order.created', { order_id: 1 })
  const m = get<{ to: string; subject: string; body: string }>("SELECT \"to\", subject, body FROM outbox WHERE channel = 'webhook'")
  assert.equal(m.to, 'https://example.com/hook')
  const sig = /sha256=([0-9a-f]{64})/.exec(m.subject)![1]
  assert.ok(dev.verifySignature(secret, m.body, sig))
  assert.equal(dev.verifySignature(secret, m.body + ' ', sig), false)
  assert.equal(dev.verifySignature('whsec_wrong', m.body, sig), false)
  // a real order for an org that has a hook is delivered
  const hookEv = run("INSERT INTO events (org_id, venue_id, slug, title, category, starts_at, status, onsale_at, ticket_limit) VALUES (?,?, 'hook-ev','H','music',?, 'published', ?, 100)", org2, venue, new Date(Date.now() + 864e5).toISOString(), new Date(Date.now() - 864e5).toISOString())
  run('INSERT INTO price_levels (event_id, name, price_cents) VALUES (?,?,5000)', hookEv, 'General')
  inv.generateInventory(hookEv)
  buy(hookEv, user('hookbuyer2'))
  const real = get<{ body: string }>("SELECT body FROM outbox WHERE channel = 'webhook' ORDER BY id DESC LIMIT 1")
  assert.equal(JSON.parse(real.body).type, 'order.created')
  assert.ok(!/@/.test(real.body))
})

test('clone event, series and the customer CSV (own org only, formula-safe)', () => {
  const cloneId = orgTools.cloneEvent(ev)
  const c = get<{ status: string; title: string; org_id: number }>('SELECT status, title, org_id FROM events WHERE id = ?', cloneId)
  assert.deepEqual([c.status, c.org_id], ['draft', org])
  assert.equal(get<{ n: number }>('SELECT count(*) AS n FROM price_levels WHERE event_id = ?', cloneId).n, 4)
  assert.throws(() => orgTools.cloneEvent(ev, new Date(Date.now() - 864e5).toISOString()), /future/)
  const made = orgTools.createSeries(ev, 3, 7)
  assert.equal(made.length, 3)
  const keys = new Set([ev, ...made].map((id) => get<{ k: string }>('SELECT series_key AS k FROM events WHERE id = ?', id).k))
  assert.equal(keys.size, 1)
  assert.throws(() => orgTools.createSeries(ev, 99, 7), /1 to 12/)
  const evil = user('=cmd|x')
  db.prepare("UPDATE users SET name = '=HYPERLINK(\"http://x\")' WHERE id = ?").run(evil)
  buy(ev, evil)
  const csv = customersCsv(org).csv
  assert.ok(csv.includes("'=HYPERLINK") && !/(^|,)=HYPERLINK/m.test(csv))
  const other = customersCsv(run("INSERT INTO orgs (name, status) VALUES ('Empty','approved')"))
  assert.equal(other.rows, 0) // another org sees none of these buyers
})

test('A/B bucketing is sticky per visitor, independent per flag and honours the share and the on/off switch', () => {
  db.prepare("INSERT INTO feature_flags (key, enabled, variant_pct) VALUES ('ab_x', 1, 50)").run()
  db.prepare("INSERT INTO feature_flags (key, enabled, variant_pct) VALUES ('ab_y', 1, 50)").run()
  const ids = Array.from({ length: 2000 }, (_, i) => `visitor-${i}`)
  const first = ids.map((id) => ab.variantFor('ab_x', id))
  assert.deepEqual(ids.map((id) => ab.variantFor('ab_x', id)), first) // same visitor, same variant, every time
  const b = first.filter((v) => v === 'B').length
  assert.ok(b > 900 && b < 1100, `50% flag put ${b}/2000 in B`)
  const second = ids.map((id) => ab.variantFor('ab_y', id))
  assert.ok(first.some((v, i) => v !== second[i])) // flags bucket independently
  ab.setVariantPct('ab_x', 0)
  assert.ok(ids.every((id) => ab.variantFor('ab_x', id) === 'A'))
  ab.setVariantPct('ab_x', 100)
  assert.ok(ids.every((id) => ab.variantFor('ab_x', id) === 'B'))
  db.prepare("UPDATE feature_flags SET enabled = 0 WHERE key = 'ab_x'").run()
  assert.ok(ids.every((id) => ab.variantFor('ab_x', id) === 'A'))
  assert.throws(() => ab.setVariantPct('ab_x', 101), /0 to 100/)
  assert.throws(() => ab.setVariantPct('nope', 10), /Unknown flag/)
  assert.equal(ab.variantFor('does_not_exist', 'v'), 'A')
})

test('i18n: Spanish nav and checkout strings, English fallback, junk language falls back to English', () => {
  assert.equal(i18n.t('es', 'co.pay'), 'Pagar')
  assert.equal(i18n.t('en', 'co.pay'), 'Pay')
  assert.equal(i18n.validLang('fr'), 'en')
  assert.equal(i18n.validLang('es'), 'es')
  const es = i18n.checkoutLabels('es')
  assert.equal(es['co.title'], 'Pago')
  assert.ok(Object.keys(i18n.checkoutLabels('en')).every((k) => es[k] && es[k] !== i18n.t('en', k as never) || k === 'co.total')) // every checkout key has a Spanish string
})

test('funnel counts are plain counters with no identity; GDPR admin erase uses the shared function and refuses admins', () => {
  const f0 = analytics.funnel(ev)
  analytics.logEvent(ev, 'view')
  assert.equal(analytics.funnel(ev).view, f0.view + 1)
  assert.deepEqual(db.prepare("SELECT name FROM pragma_table_info('events_log') ORDER BY cid").all().map((c) => (c as { name: string }).name), ['id', 'created_at', 'event_id', 'kind'])
  assert.ok(f0.hold > 0 && f0.order > 0) // holds and orders are logged by the real paths
  const target = user('erase-me')
  const admin = run("INSERT INTO users (email, name, role) VALUES ('adm@x.test','Adm','admin')")
  buy(ev, target)
  account.deleteAccount(target, null) // what /admin/privacy does (the admin action audits it)
  const u = get<{ email: string; status: string; name: string }>('SELECT email, status, name FROM users WHERE id = ?', target)
  assert.deepEqual([u.status, u.name], ['deleted', ''])
  assert.match(u.email, /deleted/)
  assert.equal(get<{ n: number }>('SELECT count(*) AS n FROM orders WHERE user_id = ?', target).n, 1) // orders are kept
  assert.throws(() => account.deleteAccount(admin, null), /Admin accounts cannot/)
  assert.equal(get<{ role: string }>('SELECT role FROM users WHERE id = ?', admin).role, 'admin')
  assert.ok(Object.keys(account.exportData(admin)).includes('account_credit'))
})
