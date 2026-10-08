import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'ticketstorm-'))
process.env.TICKETSTORM_DB = join(dir, 'test.db')
process.env.FRAUD_RANDOM_PCT = '0'
const { db } = await import('../lib/db.ts')
const inv = await import('../lib/inventory.ts')
const { finalize, refundOrder, refundEvent } = await import('../lib/orders.ts')
const pay = await import('../lib/payments.ts')
const { setCheckoutOptions, quote } = await import('../lib/pricing.ts')
const { chargeDueInstallments, plan } = await import('../lib/installments.ts')
const { completeExchange } = await import('../lib/exchange.ts')
const otp = await import('../lib/twofa.ts')
const { approveReview, fraudScore } = await import('../lib/fraud.ts')
const { submitClaim, decideClaim } = await import('../lib/protection.ts')
const { compTickets, moveSeat } = await import('../lib/orderadmin.ts')
const social = await import('../lib/social.ts')
const account = await import('../lib/account.ts')
const { createTransfer } = await import('../lib/transfers.ts')
const { scanTicket } = await import('../lib/scan.ts')
const { makeToken } = await import('../lib/safetix.ts')
const { hashPassword } = await import('../lib/auth.ts')
const { UserError } = await import('../lib/platform.ts')
test.after(() => rmSync(dir, { recursive: true, force: true }))

const run = (sql: string, ...a: (string | number | null)[]) => Number(db.prepare(sql).run(...a).lastInsertRowid)
const get = <T>(sql: string, ...a: (string | number)[]) => db.prepare(sql).get(...a) as T
const all = <T>(sql: string, ...a: (string | number)[]) => db.prepare(sql).all(...a) as T[]
const org = run("INSERT INTO orgs (name, status) VALUES ('T','approved')")
const city = run("INSERT INTO cities (name, state, lat, lng, tax_rate_bps) VALUES ('X','XX',0,0,1000)")
const venue = run("INSERT INTO venues (org_id, slug, name, address, city_id, lat, lng, tz) VALUES (?, 'v','V','a',?,0,0,'UTC')", org, city)
const sec = run("INSERT INTO sections (venue_id, name, kind, path, label_x, label_y, rank) VALUES (?, 'S', 'reserved', '', 0, 0, 3)", venue)
for (let n = 1; n <= 80; n++) run("INSERT INTO seats (section_id, row, number, x, y) VALUES (?, 'A', ?, 0, 0)", sec, n)
const day = 864e5
// two dates of one tour with different prices ($50 and $90), 40 days out
function makeEvent(slug: string, cents: number, extra = '') {
  const ev = run(`INSERT INTO events (org_id, venue_id, series_key, slug, title, category, starts_at, status, onsale_at, ticket_limit) VALUES (?,?, 'tour', ?, ?, 'music', ?, 'published', ?, 8)`, org, venue, slug, slug, new Date(Date.now() + 40 * day).toISOString(), new Date(Date.now() - day).toISOString())
  run("INSERT INTO price_levels (event_id, name, price_cents, ticket_type) VALUES (?, 'Only', ?, 'standard')", ev, cents)
  inv.generateInventory(ev)
  return ev
}
const cheap = makeEvent('cheap', 5000)
const dear = makeEvent('dear', 9000)
const user = (name: string) => run('INSERT INTO users (email, name, phone, password_hash) VALUES (?,?,?,?)', `${name}@x.test`, name, '+15550100', hashPassword('password123'))

let n = 0
type Buy = { userId?: number | null; qty?: number; last4?: string; installments?: boolean; protection?: boolean; email?: string }
function buy(ev: number, o: Buy = {}) {
  const session = `sess-${++n}`
  const userId = o.userId ?? null
  const h = inv.holdBestAvailable(ev, { sessionToken: session, userId }, o.qty ?? 1)
  if (o.protection) setCheckoutOptions(h.holdId, session, { promo: '', offers: {}, addons: {}, protection: true })
  const r = finalize({
    holdId: h.holdId, sessionToken: session, userId, email: o.email ?? `u${userId ?? 'g'}-${n}@x.test`, key: `p9-key-${n}-padding`, method: 'card', installments: o.installments,
    brand: 'Visa', last4: o.last4 ?? '4242', exp: '12/39', save: false, billing: { name: 'A', address: 'a', city: 'X', zip: '1' },
  })
  assert.ok('orderId' in r, JSON.stringify(r))
  return { orderId: r.orderId, session, holdId: h.holdId }
}
const order = (id: number) => get<{ status: string; total: number; protection: number; review_reason: string | null }>('SELECT * FROM orders WHERE id = ?', id)
const itemSum = (id: number) => get<{ s: number }>('SELECT sum(unit_cents + fee_cents + tax_cents) AS s FROM order_items WHERE order_id = ?', id).s
const seatStatuses = (id: number) => all<{ status: string }>('SELECT i.status FROM tickets t JOIN inventory i ON i.id = t.inventory_id WHERE t.order_id = ? ORDER BY t.id', id).map((r) => r.status)
const ticketStatuses = (id: number) => all<{ status: string }>('SELECT status FROM tickets WHERE order_id = ? ORDER BY id', id).map((r) => r.status)
const items = (id: number) => all<{ id: number; unit_cents: number; fee_cents: number; tax_cents: number }>("SELECT * FROM order_items WHERE order_id = ? AND kind = 'ticket' ORDER BY id", id)

test('refunds never exceed paid minus refunded: partial (with and without fees), then full', () => {
  const { orderId } = buy(cheap, { qty: 3 })
  const total = order(orderId).total
  assert.equal(itemSum(orderId), total)
  assert.equal(pay.paidOf(orderId), total)
  const [a, b, c] = items(orderId)

  // 1 of 3 with fees: only that ticket is cancelled and only its seat is freed
  const r1 = refundOrder(orderId, { reason: 't', items: [a.id] })
  assert.equal(r1.amount, a.unit_cents + a.fee_cents + a.tax_cents)
  assert.equal(r1.status, 'partially_refunded')
  assert.deepEqual(ticketStatuses(orderId), ['cancelled', 'valid', 'valid'])
  assert.deepEqual(seatStatuses(orderId), ['available', 'sold', 'sold'])
  assert.throws(() => refundOrder(orderId, { reason: 't', items: [a.id] }), UserError) // an item is refunded once

  // without fees: face value only
  const r2 = refundOrder(orderId, { reason: 't', items: [b.id], fees: false })
  assert.equal(r2.amount, b.unit_cents)

  // full refund gives back exactly what is left, then nothing more can be refunded
  const r3 = refundOrder(orderId, { reason: 't' })
  assert.equal(r3.amount, total - r1.amount - r2.amount)
  assert.equal(pay.refundedOf(orderId), total)
  assert.equal(order(orderId).status, 'refunded')
  assert.deepEqual(ticketStatuses(orderId), ['cancelled', 'cancelled', 'cancelled'])
  assert.throws(() => refundOrder(orderId, { reason: 't' }), UserError)
  assert.throws(() => pay.refundMoney(orderId, 1), /exceeds/)
  const charge = get<{ id: number }>("SELECT id FROM payments WHERE order_id = ? AND kind = 'charge'", orderId).id
  assert.throws(() => pay.refund(charge, 1), /exceeds/)
  void c
})

test('a card that refuses the refund rolls a strict refund back; refundEvent records it instead', () => {
  const { orderId } = buy(cheap, { last4: '0341' })
  assert.throws(() => refundOrder(orderId, { reason: 't' }), /refused/)
  assert.equal(order(orderId).status, 'paid')
  assert.deepEqual(ticketStatuses(orderId), ['valid'])
})

test('void cancels with no money back and frees the seat', () => {
  const { orderId } = buy(cheap)
  const r = refundOrder(orderId, { reason: 't', refund: false })
  assert.equal(r.amount, 0)
  assert.equal(order(orderId).status, 'cancelled')
  assert.equal(pay.refundedOf(orderId), 0)
  assert.deepEqual(seatStatuses(orderId), ['available'])
})

test('exchange: the price difference is charged going up and refunded going down; old ticket dies, its seat is freed', () => {
  const u = user('ex')
  const up = buy(cheap, { userId: u })
  const oldT = get<{ id: number; secret: string; inventory_id: number }>('SELECT * FROM tickets WHERE order_id = ?', up.orderId)
  const held = inv.holdBestAvailable(dear, { sessionToken: 'ex-sess', userId: u }, 1)
  const r = completeExchange(oldT.id, held.holdId, u, 'ex-sess')
  const newTotal = order(r.orderId).total
  const oldTotal = get<{ v: number }>("SELECT unit_cents + fee_cents + tax_cents AS v FROM order_items WHERE order_id = ? AND kind = 'ticket'", up.orderId).v
  assert.equal(r.diff, newTotal - oldTotal)
  assert.ok(r.diff > 0)
  assert.equal(pay.paidOf(r.orderId), newTotal) // credit carried over + the card charge for the difference
  const cardCharge = get<{ s: number }>("SELECT sum(amount) AS s FROM payments WHERE order_id = ? AND kind = 'charge' AND method = 'card'", r.orderId).s
  assert.equal(cardCharge, r.diff)
  assert.equal(get<{ status: string }>('SELECT status FROM tickets WHERE id = ?', oldT.id).status, 'cancelled')
  assert.equal(get<{ status: string }>('SELECT status FROM inventory WHERE id = ?', oldT.inventory_id).status, 'available')
  assert.equal(order(up.orderId).status, 'refunded')
  assert.equal(pay.refundedOf(up.orderId), oldTotal)
  const newT = get<{ status: string; secret: string }>('SELECT * FROM tickets WHERE order_id = ?', r.orderId)
  assert.equal(newT.status, 'valid')
  assert.notEqual(newT.secret, oldT.secret)

  // down: dear -> cheap refunds the difference to the card
  const down = buy(dear, { userId: u })
  const t2 = get<{ id: number }>('SELECT id FROM tickets WHERE order_id = ?', down.orderId)
  const held2 = inv.holdBestAvailable(cheap, { sessionToken: 'ex-sess-2', userId: u }, 1)
  const d = completeExchange(t2.id, held2.holdId, u, 'ex-sess-2')
  assert.ok(d.diff < 0)
  const refundedToCard = get<{ s: number }>("SELECT sum(amount) AS s FROM payments WHERE order_id = ? AND kind = 'refund' AND method = 'card'", down.orderId).s
  assert.equal(refundedToCard, -d.diff)
  assert.equal(pay.paidOf(d.orderId), order(d.orderId).total)
  const downValue = get<{ v: number }>("SELECT unit_cents + fee_cents + tax_cents AS v FROM order_items WHERE order_id = ? AND kind = 'ticket'", down.orderId).v
  assert.equal(pay.refundedOf(down.orderId), downValue) // the ticket is returned in full: credit + cash (the per-order fee stays)
  assert.equal(get<{ n: number }>('SELECT count(*) AS n FROM exchanges').n, 2)
})

test('a declined price difference changes nothing', () => {
  const u = user('ex2')
  const o = buy(cheap, { userId: u })
  db.prepare("UPDATE payments SET last4 = '0002' WHERE order_id = ?").run(o.orderId) // the card has since been cancelled
  const t = get<{ id: number; inventory_id: number }>('SELECT id, inventory_id FROM tickets WHERE order_id = ?', o.orderId)
  const held = inv.holdBestAvailable(dear, { sessionToken: 'ex2-sess', userId: u }, 1)
  const orders = get<{ n: number }>('SELECT count(*) AS n FROM orders').n
  assert.throws(() => completeExchange(t.id, held.holdId, u, 'ex2-sess'), /declined/)
  assert.equal(get<{ n: number }>('SELECT count(*) AS n FROM orders').n, orders)
  assert.equal(get<{ status: string }>('SELECT status FROM tickets WHERE id = ?', t.id).status, 'valid')
  assert.equal(get<{ status: string }>('SELECT status FROM inventory WHERE id = ?', t.inventory_id).status, 'sold')
  assert.equal(get<{ status: string }>("SELECT status FROM holds WHERE id = ?", held.holdId).status, 'active')
})

test('pay in 4: first quarter now, three pending; the job charges each once; a failed one puts the order in review', () => {
  const u = user('inst')
  const a = buy(cheap, { userId: u, qty: 2, installments: true })
  const rows = all<{ amount: number; status: string; method: string }>("SELECT amount, status, method FROM payments WHERE order_id = ? ORDER BY id", a.orderId)
  assert.deepEqual(rows.map((r) => r.status), ['succeeded', 'pending', 'pending', 'pending'])
  assert.ok(rows.every((r) => r.method === 'installments'))
  assert.equal(rows.reduce((s, r) => s + r.amount, 0), order(a.orderId).total)
  assert.equal(chargeDueInstallments(Date.now() + 1000), 0) // nothing due yet
  const later = Date.now() + 100 * day
  assert.equal(chargeDueInstallments(later), 3)
  assert.equal(chargeDueInstallments(later), 0) // second run: nothing left to charge
  assert.equal(pay.paidOf(a.orderId), order(a.orderId).total)

  // failure: the card now declines
  const b = buy(cheap, { userId: u, qty: 2, installments: true })
  db.prepare("UPDATE payments SET last4 = '0002' WHERE order_id = ? AND status = 'pending'").run(b.orderId)
  assert.equal(chargeDueInstallments(later), 0)
  assert.equal(order(b.orderId).status, 'review')
  assert.equal(order(b.orderId).review_reason, 'installment_failed')
  assert.equal(chargeDueInstallments(later), 0) // review pauses the rest
  assert.equal(get<{ n: number }>("SELECT count(*) AS n FROM payments WHERE order_id = ? AND status = 'pending'", b.orderId).n, 2)
  // cancelling refunds only what was paid and voids the rest
  refundOrder(b.orderId, { reason: 't' })
  assert.equal(pay.refundedOf(b.orderId), pay.paidOf(b.orderId))
  assert.equal(get<{ n: number }>("SELECT count(*) AS n FROM payments WHERE order_id = ? AND status = 'pending'", b.orderId).n, 0)
})

test('pay in 4 plan: four parts that add up, due before the show; not offered for small or near orders', () => {
  const p = plan(10001, new Date(Date.now() + 40 * day).toISOString())!
  assert.equal(p.length, 4)
  assert.equal(p.reduce((s, x) => s + x.amount, 0), 10001)
  assert.equal(p[0].dueAt, null)
  assert.ok(Date.parse(p[3].dueAt!) <= Date.now() + 39 * day + 1000) // the last part falls due a day before the show
  assert.equal(plan(3999, new Date(Date.now() + 40 * day).toISOString()), null)
  assert.equal(plan(10000, new Date(Date.now() + 2 * day).toISOString()), null)
  // guests cannot
  const session = 'g-inst'
  const h = inv.holdBestAvailable(cheap, { sessionToken: session, userId: null }, 1)
  assert.throws(() => finalize({ holdId: h.holdId, sessionToken: session, userId: null, email: 'g@x.test', key: 'guest-inst-key-1', method: 'card', installments: true, brand: 'Visa', last4: '4242', exp: '12/39', save: false, billing: { name: 'A', address: 'a', city: 'X', zip: '1' } }), /Log in/)
})

test('OTP: single use, expires, 5 wrong guesses kill it; dev code only in development with DEV_OTP=1', () => {
  const u = user('otp')
  const code = () => get<{ code: string }>("SELECT code FROM codes WHERE user_id = ? AND kind = 'otp' AND used_at IS NULL ORDER BY id DESC", u).code
  otp.sendOtp(u)
  assert.match(get<{ body: string }>("SELECT body FROM outbox WHERE channel = 'sms' ORDER BY id DESC").body, /\d{6}/)
  const c = code()
  assert.equal(otp.verifyOtp(u, c === '123456' ? '654321' : '123456'), false)
  assert.equal(otp.verifyOtp(u, c), true)
  assert.equal(otp.verifyOtp(u, c), false) // used

  otp.sendOtp(u)
  const old = code()
  otp.sendOtp(u) // a new code replaces the old one
  assert.equal(otp.verifyOtp(u, old), old === code())
  const c2 = code()
  for (let i = 0; i < otp.MAX_ATTEMPTS; i++) otp.verifyOtp(u, c2 === '000001' ? '000002' : '000001')
  assert.equal(otp.verifyOtp(u, c2), false) // too many wrong guesses

  otp.sendOtp(u, Date.now() - 11 * 60_000) // sent 11 minutes ago
  assert.equal(otp.verifyOtp(u, code()), false) // expired

  const was = [process.env.NODE_ENV, process.env.DEV_OTP]
  const env = process.env as Record<string, string | undefined>
  env.NODE_ENV = 'production'; env.DEV_OTP = '1'
  assert.equal(otp.devOtp(), false)
  env.NODE_ENV = 'development'; env.DEV_OTP = undefined
  assert.equal(otp.devOtp(), false)
  env.DEV_OTP = '1'
  assert.equal(otp.devOtp(), true)
  otp.sendOtp(u)
  assert.equal(code(), '000000')
  assert.equal(otp.verifyOtp(u, '000000'), true)
  env.NODE_ENV = was[0]; env.DEV_OTP = was[1]
  otp.sendOtp(u)
  assert.equal(otp.devOtp(), false)

  // the pending-login token only works for the session that passed the password step
  const t = otp.pendingToken('sess-a', u)
  assert.equal(otp.checkPending(t, 'sess-a'), u)
  assert.equal(otp.checkPending(t, 'sess-b'), undefined)
  assert.equal(otp.checkPending(t, 'sess-a', Date.now() + 11 * 60_000), undefined)
})

test('fraud review: tickets cannot be scanned or sent until approved; cancelling refunds and frees the seats', () => {
  const u = user('fraud')
  assert.ok(fraudScore({ userId: u, billingCity: 'X', total: 60000 }).score >= 50)
  const { orderId } = buy(dear, { userId: u, qty: 6 }) // $540+ on a new account
  assert.equal(order(orderId).status, 'review')
  const t = get<{ id: number; secret: string }>('SELECT id, secret FROM tickets WHERE order_id = ? ORDER BY id', orderId)
  const scanner = u
  assert.equal(scanTicket(dear, makeToken(t.id, t.secret), scanner).result, 'invalid')
  assert.throws(() => createTransfer(u, t.id, 'someone@x.test'), /under review/)
  assert.ok(approveReview(orderId))
  assert.equal(scanTicket(dear, makeToken(t.id, t.secret), scanner).result, 'valid')

  const r = buy(dear, { userId: user('fraud2'), qty: 6 })
  assert.equal(order(r.orderId).status, 'review')
  refundOrder(r.orderId, { reason: 'review_cancelled' })
  assert.equal(pay.refundedOf(r.orderId), order(r.orderId).total)
  assert.ok(seatStatuses(r.orderId).every((s) => s === 'available'))
})

test('protection: priced on the ticket subtotal, sum(items) == total; approved claim refunds all but the premium', () => {
  const u = user('prot')
  const { orderId } = buy(cheap, { userId: u, qty: 2, protection: true })
  const o = order(orderId)
  assert.equal(o.protection, Math.round(2 * 5000 * 0.08))
  assert.equal(itemSum(orderId), o.total)
  assert.throws(() => submitClaim(orderId, 'nonsense', ''), UserError)
  submitClaim(orderId, 'illness', 'flu')
  assert.throws(() => submitClaim(orderId, 'illness', 'again'), /already has a claim/)
  const claim = get<{ id: number }>('SELECT id FROM claims WHERE order_id = ?', orderId).id
  decideClaim(claim, u, true)
  assert.equal(pay.refundedOf(orderId), o.total - o.protection)
  assert.equal(order(orderId).status, 'refunded')
  assert.deepEqual(ticketStatuses(orderId), ['cancelled', 'cancelled'])
  assert.deepEqual(seatStatuses(orderId), ['sold', 'sold']) // seats stay sold, like refundEvent
  assert.throws(() => decideClaim(claim, u, true), /already decided/)
  // no protection, no claim
  const plain = buy(cheap, { userId: u })
  assert.throws(() => submitClaim(plain.orderId, 'illness', ''), /no ticket protection/)
})

test('organizer tools: move seat kills the old QR; comps do not count toward the ticket limit', () => {
  const { orderId } = buy(cheap, { userId: user('mv') })
  const t = get<{ id: number; secret: string; inventory_id: number }>('SELECT * FROM tickets WHERE order_id = ?', orderId)
  const id = moveSeat(orderId, t.id, { section: 'S', row: 'A', number: 80 })
  assert.equal(get<{ status: string }>('SELECT status FROM tickets WHERE id = ?', t.id).status, 'cancelled')
  assert.equal(get<{ status: string }>('SELECT status FROM inventory WHERE id = ?', t.inventory_id).status, 'available')
  const nt = get<{ secret: string; status: string }>('SELECT secret, status FROM tickets WHERE id = ?', id)
  assert.notEqual(nt.secret, t.secret)
  assert.equal(scanTicket(cheap, makeToken(t.id, t.secret), 1).result, 'invalid')
  assert.equal(itemSum(orderId), order(orderId).total)
  assert.throws(() => moveSeat(orderId, id, { section: 'S', row: 'A', number: 80 }), /not available/) // its own seat is taken

  run('UPDATE events SET ticket_limit = 1 WHERE id = ?', dear)
  const comp = compTickets(dear, 'comped@x.test', [{ section: 'S', row: 'A', number: 80 }], '')
  assert.equal(order(comp).total, 0)
  assert.equal(get<{ source: string }>('SELECT source FROM orders WHERE id = ?', comp).source, 'comp')
  buy(dear, { email: 'comped@x.test' }) // limit 1, but the comp does not count
  assert.throws(() => buy(dear, { email: 'comped@x.test' }), /Limit 1/)
  run('UPDATE events SET ticket_limit = 8 WHERE id = ?', dear)
})

test('social login: links only verified emails, state is bound to the session and single use', () => {
  const a = social.socialUser('google', 'newbie@x.test', 'New Bie', true)
  assert.equal(social.socialUser('google', 'newbie@x.test', 'x', false), a) // known identity
  assert.equal(get<{ email_verified_at: string | null }>('SELECT email_verified_at FROM users WHERE id = ?', a).email_verified_at !== null, true)
  const existing = user('existing')
  assert.throws(() => social.socialUser('apple', 'existing@x.test', 'E', false), /not verified/)
  assert.equal(social.socialUser('apple', 'existing@x.test', 'E', true), existing)
  assert.equal(get<{ n: number }>('SELECT count(*) AS n FROM oauth_links WHERE user_id = ?', existing).n, 1)
  assert.throws(() => social.socialUser('nope', 'a@b.test', '', true), UserError)

  const s = social.socialState('sess-1', 'google')
  assert.equal(social.checkState(s, 'sess-2', 'google', true), false) // other session
  assert.equal(social.checkState(s, 'sess-1', 'facebook', true), false) // other provider
  assert.equal(social.checkState(s, 'sess-1', 'google', false), true) // viewing does not burn
  assert.equal(social.checkState(s, 'sess-1', 'google', true), true)
  assert.equal(social.checkState(s, 'sess-1', 'google', true), false) // used
  assert.equal(social.checkState(social.socialState('sess-1', 'google', 0), 'sess-1', 'google', true), false) // expired
})

test('account: export holds only the user\'s own data; delete anonymizes but keeps orders; saved cards are owner-only', () => {
  const u = user('gdpr')
  const other = user('gdpr-other')
  const mine = buy(cheap, { userId: u })
  const theirs = buy(cheap, { userId: other })
  const data = account.exportData(u)
  const text = JSON.stringify(data)
  assert.deepEqual(data.orders.map((o: { id: number }) => o.id), [mine.orderId])
  assert.ok(!text.includes('password_hash') && !text.includes('secret') && !text.includes(`gdpr-other@x.test`))
  assert.equal(data.user.email, 'gdpr@x.test')

  run("INSERT INTO saved_cards (user_id, brand, last4, exp, fake_token) VALUES (?, 'Visa', '4242', '12/39', 'tok')", u)
  const card = get<{ id: number }>('SELECT id FROM saved_cards WHERE user_id = ?', u).id
  assert.throws(() => account.deleteCard(other, card), UserError)
  account.deleteCard(u, card)

  const t = get<{ id: number }>('SELECT id FROM tickets WHERE order_id = ?', mine.orderId)
  run("INSERT INTO sessions (token, user_id, expires_at) VALUES ('gdpr-sess', ?, '2099-01-01')", u)
  assert.throws(() => account.deleteAccount(u, 'wrong'), /Wrong password/)
  account.deleteAccount(u, 'password123')
  const row = get<{ email: string; name: string; phone: string | null; status: string; password_hash: string | null }>('SELECT * FROM users WHERE id = ?', u)
  assert.deepEqual([row.name, row.phone, row.status, row.password_hash], ['', null, 'deleted', null])
  assert.ok(row.email.endsWith('@deleted.invalid'))
  assert.equal(get<{ n: number }>("SELECT count(*) AS n FROM sessions WHERE user_id = ?", u).n, 0)
  assert.equal(order(mine.orderId).total > 0, true)
  assert.equal(get<{ email: string }>('SELECT email FROM orders WHERE id = ?', mine.orderId).email, row.email)
  assert.equal(get<{ owner_id: number }>('SELECT owner_id FROM tickets WHERE id = ?', t.id).owner_id, u)
  assert.equal(order(theirs.orderId).status, 'paid')
})

test('refundEvent still refunds every order through the shared function', () => {
  const ev = makeEvent('doomed', 5000)
  const a = buy(ev, { qty: 2 })
  const b = buy(ev, { userId: user('doom'), last4: '0341' })
  const r = refundEvent(ev)
  assert.deepEqual(r, { refunded: 1, failed: 1 })
  assert.equal(order(a.orderId).status, 'refunded')
  assert.equal(pay.refundedOf(a.orderId), order(a.orderId).total)
  assert.equal(order(b.orderId).status, 'cancelled')
  assert.equal(get<{ refund_error: string }>('SELECT refund_error FROM orders WHERE id = ?', b.orderId).refund_error, 'refund_failed')
  assert.deepEqual(seatStatuses(a.orderId), ['sold', 'sold']) // closed event keeps its seats
  void quote
})
