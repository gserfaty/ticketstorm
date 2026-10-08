import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'ticketstorm-'))
process.env.TICKETSTORM_DB = join(dir, 'test.db')
const { db } = await import('../lib/db.ts')
const inv = await import('../lib/inventory.ts')
const { pageMath, viewingNow, relatedEvents, topPicks } = await import('../lib/discover.ts')
const { sitemapEntries } = await import('../lib/seo.ts')
const { weather } = await import('../lib/weather.ts')
const { searchEvents } = await import('../lib/events.ts')
test.after(() => rmSync(dir, { recursive: true, force: true }))

const run = (sql: string, ...a: (string | number | null)[]) => Number(db.prepare(sql).run(...a).lastInsertRowid)
const org = run("INSERT INTO orgs (name, status) VALUES ('T','approved')")
const city = run("INSERT INTO cities (name, state, lat, lng, tax_rate_bps) VALUES ('X','XX',40,-75,1000)")
const venue = run("INSERT INTO venues (org_id, slug, name, address, city_id, lat, lng, tz) VALUES (?, 'v','V','a',?,40,-75,'UTC')", org, city)
const sec = run("INSERT INTO sections (venue_id, name, kind, path, label_x, label_y, rank) VALUES (?, 'S', 'reserved', '', 0, 0, 1)", venue)
for (let n = 1; n <= 10; n++) run("INSERT INTO seats (section_id, row, number, x, y) VALUES (?, 'A', ?, 0, 0)", sec, n)
const mkEvent = (slug: string, o: { status?: string; approved?: number; days?: number; category?: string; genre?: string; pop?: number } = {}) => {
  const ev = run("INSERT INTO events (org_id, venue_id, slug, title, category, genre, starts_at, status, approved, popularity, ticket_limit) VALUES (?,?,?,?,?,?,?,?,?,?,8)",
    org, venue, slug, slug, o.category ?? 'music', o.genre ?? 'Pop', new Date(Date.now() + (o.days ?? 5) * 864e5).toISOString(), o.status ?? 'published', o.approved ?? 1, o.pop ?? 0)
  for (const n of ['General', 'Premium', 'VIP', 'Accessible']) run('INSERT INTO price_levels (event_id, name, price_cents, ticket_type) VALUES (?,?,5000,?)', ev, n, 'standard')
  inv.generateInventory(ev)
  return ev
}

test('pageMath clamps junk page numbers and counts the last partial page', () => {
  assert.deepEqual(pageMath(45, '2', 20), { page: 2, pages: 3, offset: 20, count: 20 })
  assert.deepEqual(pageMath(45, '3', 20), { page: 3, pages: 3, offset: 40, count: 5 })
  assert.equal(pageMath(45, '99', 20).page, 3)
  for (const bad of ['0', '-4', 'abc', undefined, '1.5', NaN]) assert.equal(pageMath(45, bad, 20).page, 1)
  assert.deepEqual(pageMath(0, '5', 20), { page: 1, pages: 1, offset: 0, count: 0 })
})

test('searchEvents offset walks the same ordered list without gaps or repeats', () => {
  for (let i = 0; i < 7; i++) mkEvent(`pg-${i}`, { days: 10 + i, category: 'comedy' })
  const all = searchEvents({ category: 'comedy', unit: 'mi' }, 100).rows.map((r) => r.slug)
  assert.equal(all.length, 7)
  const pages = [0, 3, 6].flatMap((o) => searchEvents({ category: 'comedy', unit: 'mi' }, 3, { offset: o }).rows.map((r) => r.slug))
  assert.deepEqual(pages, all)
  assert.equal(searchEvents({ category: 'comedy', unit: 'mi' }, 3, { offset: 6 }).total, 7)
})

test('sitemap lists public upcoming events only', () => {
  mkEvent('pub-1')
  mkEvent('hidden-draft', { status: 'draft' })
  mkEvent('hidden-unapproved', { approved: 0 })
  mkEvent('hidden-past', { days: -3 })
  const urls = sitemapEntries().map((e) => e.url)
  assert.ok(urls.some((u) => u.endsWith('/events/pub-1')))
  for (const s of ['hidden-draft', 'hidden-unapproved', 'hidden-past']) assert.ok(!urls.some((u) => u.endsWith(`/events/${s}`)), s)
  assert.ok(urls.some((u) => u.endsWith('/venues/v')))
})

test('simulated weather is deterministic per date and city', () => {
  assert.deepEqual(weather('2026-07-04', 'Boston', 42), weather('2026-07-04', 'Boston', 42))
  const days = new Set(Array.from({ length: 20 }, (_, i) => JSON.stringify(weather(`2026-07-${String(i + 1).padStart(2, '0')}`, 'Boston', 42))))
  assert.ok(days.size > 5)
  assert.ok(weather('2026-07-04', 'Boston', 42).highC > weather('2026-01-04', 'Boston', 42).highC)
})

test('viewing count = distinct sessions holding seats + recent waiting-room entries, nothing else', () => {
  const ev = mkEvent('viewed')
  assert.equal(viewingNow(ev), 0)
  inv.holdBestAvailable(ev, { sessionToken: 'a', userId: null }, 2)
  inv.holdBestAvailable(ev, { sessionToken: 'b', userId: null }, 1)
  assert.equal(viewingNow(ev), 2)
  run("INSERT INTO queue_entries (event_id, session_token, rank, joined_at, seen_at) VALUES (?, 'q1', 1, ?, ?)", ev, new Date().toISOString(), new Date().toISOString())
  run("INSERT INTO queue_entries (event_id, session_token, rank, joined_at, seen_at) VALUES (?, 'q2', 2, ?, ?)", ev, new Date().toISOString(), new Date(Date.now() - 10 * 60_000).toISOString())
  assert.equal(viewingNow(ev), 3)
})

test('related events share a category and genre or artist, never the event itself or its own tour', () => {
  const a = mkEvent('rel-a', { category: 'sports', genre: 'Hockey', pop: 10 })
  const b = mkEvent('rel-b', { category: 'sports', genre: 'Hockey', pop: 90 })
  mkEvent('rel-c', { category: 'sports', genre: 'Soccer' })
  mkEvent('rel-d', { category: 'music', genre: 'Hockey' })
  const slugs = relatedEvents({ id: a, category: 'sports', genre: 'Hockey', series_key: null }).map((e) => e.slug)
  assert.deepEqual(slugs, ['rel-b'])
  assert.ok(b)
  assert.ok(topPicks().length > 0)
})

test('SSE frames are the compact availability only: no hold ids, sessions or owners', async () => {
  const { snapshot, acquire, release, streamCount, MAX_STREAMS } = await import('../lib/stream.ts')
  const ev = mkEvent('sse')
  const held = inv.holdBestAvailable(ev, { sessionToken: 'secret-session-token', userId: run("INSERT INTO users (email, name) VALUES ('sse@x.test','sse')") }, 2)
  const raw = snapshot(ev, [])
  const data = JSON.parse(raw) as { seats: unknown[][]; ga: unknown[] }
  assert.deepEqual(Object.keys(data).sort(), ['ga', 'seats'])
  assert.ok(data.seats.every((s) => s.length === 3 && typeof s[0] === 'number' && typeof s[1] === 'string' && typeof s[2] === 'number'))
  assert.equal(data.seats.filter((s) => s[1] === 'h').length, 2)
  assert.ok(!/hold|session|secret|user|expires/i.test(raw))
  assert.ok(held.holdId > 0)
  // the cap: MAX_STREAMS connections, then refusal until one closes
  const before = streamCount()
  let n = 0
  while (acquire()) n++
  assert.equal(n, MAX_STREAMS - before)
  assert.equal(acquire(), false)
  release()
  assert.equal(acquire(), true)
  for (let i = 0; i < MAX_STREAMS; i++) release()
  assert.equal(streamCount(), 0)
})

// ---- rules, flags, alerts ----
const { finalize } = await import('../lib/orders.ts')
const { createTransfer, acceptTransfer } = await import('../lib/transfers.ts')
const { createListing } = await import('../lib/resale.ts')
const { setPriceAlert, getPriceAlert, priceTargetAlerts } = await import('../lib/pricealerts.ts')
const { runAlerts } = await import('../lib/alerts.ts')
const { setDeliveryRules, assertDelivery } = await import('../lib/rules.ts')
const { clusters, cancelCluster, SCALPER_ACCOUNTS } = await import('../lib/scalpers.ts')
const { markPickedUp, willCallOrders } = await import('../lib/orderadmin.ts')
const { scanTicket } = await import('../lib/scan.ts')
const { makeToken, makePrintToken } = await import('../lib/safetix.ts')
const user = (name: string) => run('INSERT INTO users (email, name) VALUES (?,?)', `${name}@x.test`, name)
const get = <T>(sql: string, ...a: (string | number)[]) => db.prepare(sql).get(...a) as T
let n = 0
function buy(userId: number | null, event: number, o: { qty?: number; delivery?: string; ip?: string; cardFp?: string; email?: string } = {}) {
  const session = `s${++n}`
  const h = inv.holdBestAvailable(event, { sessionToken: session, userId }, o.qty ?? 1)
  const r = finalize({ holdId: h.holdId, sessionToken: session, userId, email: o.email ?? `u${userId}@x.test`, key: `key-${n}-padding`, method: 'card', brand: 'Visa', last4: '4242', exp: '12/39', save: false,
    billing: { name: 'A', address: 'x', city: 'X', zip: '1' }, delivery: o.delivery, ip: o.ip, cardFp: o.cardFp })
  assert.ok('orderId' in r)
  return { orderId: r.orderId, tickets: (db.prepare('SELECT id FROM tickets WHERE order_id = ? ORDER BY id').all(r.orderId) as { id: number }[]).map((t) => t.id) }
}
const holdErr = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: Error) => e instanceof inv.HoldError && re.test(e.message))

test('non-transferable tickets can be neither sent nor resold, and accept re-checks', () => {
  const ev = mkEvent('nt')
  const [a, b] = [user('nt-a'), user('nt-b')]
  const [t1, t2] = buy(a, ev, { qty: 2 }).tickets
  const pending = createTransfer(a, t2, 'friend@x.test') // allowed while the flag is off
  setDeliveryRules(ev, { print_ok: false, willcall_ok: false, non_transferable: true })
  holdErr(() => createTransfer(a, t1, 'friend@x.test'), /non-transferable/)
  holdErr(() => createListing(a, t1, 5000), /non-transferable/)
  const tok = get<{ claim_token: string }>('SELECT claim_token FROM transfers WHERE id = ?', pending).claim_token
  holdErr(() => acceptTransfer(b, pending, tok), /non-transferable/)
  assert.equal(get<{ owner_id: number }>('SELECT owner_id FROM tickets WHERE id = ?', t2).owner_id, a)
  setDeliveryRules(ev, { print_ok: false, willcall_ok: false, non_transferable: false })
  assert.ok(createListing(a, t1, 5000) > 0)
})

test('price alert notifies exactly once at or below the target; a new target re-arms it', () => {
  const ev = mkEvent('alerting')
  const u = user('pa')
  assert.throws(() => setPriceAlert(u, ev, 'abc'), /target price/)
  setPriceAlert(u, ev, '40') // cheapest level is $50
  const count = () => get<{ n: number }>("SELECT count(*) AS n FROM notifications WHERE user_id = ? AND kind = 'price_target'", u).n
  runAlerts(); runAlerts()
  assert.equal(count(), 0)
  db.prepare('UPDATE price_levels SET price_cents = 3500 WHERE event_id = ? AND name = ?').run(ev, 'General')
  runAlerts(); runAlerts(); runAlerts()
  assert.equal(count(), 1)
  assert.equal(priceTargetAlerts(), 0) // calling the job again directly sends nothing either
  assert.equal(getPriceAlert(u, ev)?.notified, true)
  setPriceAlert(u, ev, '36') // a different target is a new alert
  runAlerts(); runAlerts()
  assert.equal(count(), 2)
})

test('delivery choices are checked against the event; print codes work only where printing is allowed and only once', () => {
  const ev = mkEvent('delivery')
  const u = user('dl')
  holdErr(() => assertDelivery(ev, 'print'), /mobile-only/)
  holdErr(() => assertDelivery(ev, 'willcall'), /Will-call/)
  holdErr(() => assertDelivery(ev, 'pigeon'), /Choose a delivery/)
  const scanner = user('dl-scan')
  const { tickets: [t] } = buy(u, ev)
  const secret = get<{ secret: string }>('SELECT secret FROM tickets WHERE id = ?', t).secret
  assert.equal(scanTicket(ev, makePrintToken(t, secret), scanner).result, 'invalid') // mobile-only event: a printed code is refused
  setDeliveryRules(ev, { print_ok: true, willcall_ok: true, non_transferable: false })
  assert.equal(assertDelivery(ev, 'print'), 'print')
  assert.equal(scanTicket(ev, makePrintToken(t, 'wrong-secret'), scanner).result, 'invalid')
  assert.equal(scanTicket(ev, makePrintToken(t, secret), scanner).result, 'valid')
  assert.equal(scanTicket(ev, makePrintToken(t, secret), scanner).result, 'used')
  assert.equal(scanTicket(ev, makeToken(t, secret), scanner).result, 'used') // the mobile code of a used ticket is dead as well
  // the order remembers its delivery
  const w = buy(u, ev, { delivery: 'willcall' })
  assert.equal(get<{ delivery: string }>('SELECT delivery FROM orders WHERE id = ?', w.orderId).delivery, 'willcall')
})

test('will-call pickup is marked once, by staff, and only for will-call orders', () => {
  const ev = mkEvent('willcall')
  setDeliveryRules(ev, { print_ok: false, willcall_ok: true, non_transferable: false })
  const [u, staff] = [user('wc'), user('wc-staff')]
  const mobile = buy(u, ev)
  const wc = buy(u, ev, { delivery: 'willcall' })
  assert.deepEqual(willCallOrders(ev).map((o) => o.id), [wc.orderId])
  assert.throws(() => markPickedUp(mobile.orderId, staff), /not a will-call/i)
  markPickedUp(wc.orderId, staff)
  assert.throws(() => markPickedUp(wc.orderId, staff), /not a will-call/i)
  assert.equal(willCallOrders(ev)[0].picked_up_at !== null, true)
})

test('scalper clusters: 3 accounts on one card or IP flag the accounts; bulk cancel refunds through the shared refund function', () => {
  const ev = mkEvent('scalp')
  const us = [user('sc1'), user('sc2'), user('sc3'), user('sc-ok')]
  const flagged = (id: number) => get<{ flagged: number }>('SELECT flagged FROM users WHERE id = ?', id).flagged
  buy(us[0], ev, { cardFp: 'fp-1', ip: '198.51.100.7' })
  buy(us[1], ev, { cardFp: 'fp-1', ip: 'local' })
  assert.equal(SCALPER_ACCOUNTS, 3)
  assert.deepEqual(clusters(ev), [])
  assert.deepEqual(us.map(flagged), [0, 0, 0, 0])
  const third = buy(us[2], ev, { cardFp: 'fp-1', ip: 'local' })
  assert.equal(clusters(ev).length, 1)
  assert.equal(clusters(ev)[0].kind, 'card')
  assert.deepEqual(us.map(flagged), [1, 1, 1, 0])
  assert.equal(get<{ n: number }>("SELECT count(*) AS n FROM audit_log WHERE action = 'scalper.flag' AND actor_id IS NULL").n, 1)
  buy(us[3], ev, { cardFp: 'fp-other', ip: 'local' }) // an unrelated buyer is not caught
  assert.equal(flagged(us[3]), 0)
  // unknown IPs never cluster: three accounts on 'local' stay unflagged
  const ev2 = mkEvent('scalp-local')
  for (const u of us.slice(0, 3)) buy(u, ev2, { ip: 'local' })
  assert.deepEqual(clusters(ev2), [])
  // bulk cancel
  const held = (e: number) => get<{ n: number }>("SELECT count(*) AS n FROM inventory WHERE event_id = ? AND status = 'sold'", e).n
  assert.equal(held(ev), 4)
  const r = cancelCluster(ev, 'card', 'fp-1')
  assert.equal(r.cancelled.length, 3)
  assert.equal(r.failed.length, 0)
  assert.equal(held(ev), 1) // the three seats are back on sale; the unrelated buyer keeps theirs
  assert.equal(get<{ status: string }>('SELECT status FROM orders WHERE id = ?', third.orderId).status, 'refunded')
  assert.equal(get<{ n: number }>("SELECT count(*) AS n FROM payments WHERE kind = 'refund' AND status = 'succeeded' AND order_id = ?", third.orderId).n, 1)
  assert.equal(cancelCluster(ev, 'card', 'fp-1').cancelled.length, 0) // nothing left, idempotent
  assert.throws(() => cancelCluster(ev, 'bogus', 'x'))
})

// ---- checkout extras ----
const { requestCode, redeemCode, LOOKUP_TTL_MS, MAX_TRIES } = await import('../lib/lookup.ts')
const { approx, convert, displayCurrency, validCurrency } = await import('../lib/currency.ts')
const { setProtection, parseOptions, quote, setCheckoutOptions } = await import('../lib/pricing.ts')
const { addCard, setDefaultCard } = await import('../lib/account.ts')
const lastCode = () => /is (\d{6})\./.exec(get<{ body: string }>("SELECT body FROM outbox WHERE subject LIKE '%lookup code%' ORDER BY id DESC").body)![1]
const mails = () => get<{ n: number }>("SELECT count(*) AS n FROM outbox WHERE subject LIKE '%lookup code%'").n

test('guest lookup: mismatches mail nothing, a code works once, expires, and dies after too many wrong guesses', () => {
  const ev = mkEvent('lookup')
  const { orderId } = buy(null, ev, { email: 'Guest@X.test' })
  const m0 = mails()
  assert.equal(requestCode('other@x.test', orderId), false) // wrong email: nothing mailed
  assert.equal(requestCode('guest@x.test', orderId + 999), false) // no such order: nothing mailed
  assert.equal(mails(), m0)
  const t0 = Date.now()
  assert.equal(requestCode('guest@x.test', orderId, t0), true) // case-insensitive email
  assert.equal(mails(), m0 + 1)
  const code = lastCode()
  assert.equal(redeemCode('guest@x.test', orderId, code === '000000' ? '111111' : '000000', t0), undefined) // wrong guess
  const ok = redeemCode('guest@x.test', orderId, code, t0 + 1000)
  assert.equal(ok?.orderId, orderId)
  assert.equal(ok?.token, get<{ access_token: string }>('SELECT access_token FROM orders WHERE id = ?', orderId).access_token)
  assert.equal(redeemCode('guest@x.test', orderId, code, t0 + 2000), undefined) // single use
  // expiry
  requestCode('guest@x.test', orderId, t0)
  const c2 = lastCode()
  assert.equal(redeemCode('guest@x.test', orderId, c2, t0 + LOOKUP_TTL_MS + 1), undefined)
  // a new request kills the older code; wrong guesses lock the code
  requestCode('guest@x.test', orderId, t0)
  const c3 = lastCode()
  requestCode('guest@x.test', orderId, t0)
  const c4 = lastCode()
  if (c3 !== c4) assert.equal(redeemCode('guest@x.test', orderId, c3, t0), undefined)
  for (let i = 0; i < MAX_TRIES; i++) redeemCode('guest@x.test', orderId, c4 === '123456' ? '654321' : '123456', t0)
  assert.equal(redeemCode('guest@x.test', orderId, c4, t0), undefined) // locked even with the right code
  // an account order gets no token (log in instead)
  const owner = user('lookup-owner')
  const acct = buy(owner, ev, { email: 'lookup-owner@x.test' }).orderId
  requestCode('lookup-owner@x.test', acct, t0)
  assert.equal(redeemCode('lookup-owner@x.test', acct, lastCode(), t0)?.token, null)
  // the stored value is a keyed hash, not the code
  assert.ok(!db.prepare('SELECT code_hash FROM lookup_codes').all().some((r) => (r as { code_hash: string }).code_hash === c4))
})

test('display currency is a fixed-rate approximation; unknown codes fall back to USD', () => {
  assert.equal(validCurrency('XXX'), 'USD')
  assert.equal(validCurrency('__proto__'), 'USD')
  assert.equal(approx(10000, 'USD'), '')
  assert.equal(convert(10000, 'CAD'), 136)
  assert.match(approx(10000, 'CAD'), /^≈ \$?CA?\$?136\.00$|^≈ .*136\.00$/)
  assert.equal(displayCurrency(undefined, 'CA'), 'CAD')
  assert.equal(displayCurrency('EUR', 'CA'), 'EUR')
  assert.equal(displayCurrency(undefined, 'US'), 'USD')
})

test('protection step stores a yes or no without touching other options; declined stays answered', () => {
  const ev = mkEvent('protect')
  const h = inv.holdBestAvailable(ev, { sessionToken: 'prot', userId: null }, 2)
  assert.equal(parseOptions(get<{ options: string | null }>('SELECT options FROM holds WHERE id = ?', h.holdId).options).protection, undefined)
  const base = quote(h.holdId).total
  setProtection(h.holdId, 'prot', true)
  assert.ok(quote(h.holdId).protection > 0)
  assert.equal(quote(h.holdId).total, base + quote(h.holdId).protection)
  setProtection(h.holdId, 'prot', false)
  assert.equal(parseOptions(get<{ options: string | null }>('SELECT options FROM holds WHERE id = ?', h.holdId).options).protection, false)
  assert.equal(quote(h.holdId).total, base)
  assert.throws(() => setProtection(h.holdId, 'someone-else', true), /expired/)
  // the options form keeps "no" as an answer too
  setCheckoutOptions(h.holdId, 'prot', { promo: '', offers: {}, addons: {}, protection: false })
  assert.equal(parseOptions(get<{ options: string | null }>('SELECT options FROM holds WHERE id = ?', h.holdId).options).protection, false)
})

test('wallet: cards are validated, fingerprinted, capped; one default', () => {
  const u = user('wallet')
  assert.throws(() => addCard(u, { number: '4242424242424241', exp: '12/39', cvc: '123' }, false), /invalid/)
  addCard(u, { number: '4242424242424242', exp: '12/39', cvc: '123' }, false)
  addCard(u, { number: '5555555555554444', exp: '11/39', cvc: '123' }, true)
  assert.throws(() => addCard(u, { number: '4242424242424242', exp: '12/39', cvc: '123' }, false), /already/)
  const cards = db.prepare('SELECT id, last4, is_default, fp FROM saved_cards WHERE user_id = ? ORDER BY id').all(u) as { id: number; last4: string; is_default: number; fp: string }[]
  assert.deepEqual(cards.map((c) => c.is_default), [0, 1])
  assert.ok(cards.every((c) => c.fp.length === 32 && !c.fp.includes(c.last4 + '0000')))
  setDefaultCard(u, cards[0].id)
  assert.deepEqual((db.prepare('SELECT is_default FROM saved_cards WHERE user_id = ? ORDER BY id').all(u) as { is_default: number }[]).map((c) => c.is_default), [1, 0])
  assert.throws(() => setDefaultCard(user('wallet-other'), cards[0].id), /not found/)
})

// ---- party link ----
const { partyToken, verifyParty, partyView } = await import('../lib/party.ts')

test('party link: signed, tamper-proof, expires, and shows seats without ever exposing the ticket secret', () => {
  const ev = mkEvent('party')
  const host = run("INSERT INTO users (email, name) VALUES ('host@x.test', 'Hannah Host')")
  const { tickets } = buy(host, ev, { qty: 2 })
  const starts = get<{ starts_at: string }>('SELECT starts_at FROM events WHERE id = ?', ev).starts_at
  const tok = partyToken(host, ev, starts)
  assert.deepEqual(verifyParty(tok), { userId: host, eventId: ev })
  const [u, e, exp, sig] = tok.split('.')
  for (const bad of [`${Number(u) + 1}.${e}.${exp}.${sig}`, `${u}.${Number(e) + 1}.${exp}.${sig}`, `${u}.${e}.${Number(exp) + 1}.${sig}`, `${u}.${e}.${exp}.${sig.replace(/^./, sig[0] === 'a' ? 'b' : 'a')}`, `${u}.${e}.${exp}`, '', 'x.y.z.w', tok + '0'])
    assert.equal(verifyParty(bad), undefined, bad)
  assert.equal(verifyParty(tok, Number(exp) + 1), undefined) // expired
  const view = partyView(host, ev)!
  assert.equal(view.host, 'Hannah')
  assert.equal(view.seats.length, 2)
  const json = JSON.stringify(view)
  for (const t of tickets) assert.ok(!json.includes(get<{ secret: string }>('SELECT secret FROM tickets WHERE id = ?', t).secret))
  assert.ok(!/@|secret|token/i.test(json))
})
