import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'ticketstorm-'))
process.env.TICKETSTORM_DB = join(dir, 'test.db')
const { db } = await import('../lib/db.ts')
const inv = await import('../lib/inventory.ts')
const { finalize } = await import('../lib/orders.ts')
const P = await import('../lib/pricing.ts')
const org = await import('../lib/organizer.ts')
const { makeToken } = await import('../lib/safetix.ts')
const { scanTicket } = await import('../lib/scan.ts')
const { UserError } = await import('../lib/platform.ts')
test.after(() => rmSync(dir, { recursive: true, force: true }))

const run = (sql: string, ...a: (string | number | null)[]) => Number(db.prepare(sql).run(...a).lastInsertRowid)
const get = <T,>(sql: string, ...a: (string | number | null)[]) => db.prepare(sql).get(...a) as T
const orgId = run("INSERT INTO orgs (name, status) VALUES ('T','approved')")
const city = run("INSERT INTO cities (name, state, lat, lng, tax_rate_bps) VALUES ('X','XX',0,0,1000)")
const scanner = run("INSERT INTO users (email, name, password_hash) VALUES ('scan@x.test','S','x')")

// A fresh venue + event per test (so tests don't see each other's seats): rows A and B of 30 seats, all $100 General-ish.
let n = 0
function makeEvent(opts: { limit?: number; orderLimit?: number | null } = {}) {
  const tag = `p${++n}`
  const venue = run("INSERT INTO venues (org_id, slug, name, address, city_id, lat, lng, tz) VALUES (?,?,?,'a',?,0,0,'UTC')", orgId, tag, tag, city)
  const sec = run("INSERT INTO sections (venue_id, name, kind, path, label_x, label_y, rank) VALUES (?, 'S', 'reserved', '', 0, 0, 3)", venue)
  for (const row of ['A', 'B']) for (let i = 1; i <= 30; i++) run('INSERT INTO seats (section_id, row, number, x, y) VALUES (?,?,?,0,0)', sec, row, i)
  const ev = run("INSERT INTO events (org_id, venue_id, slug, title, category, starts_at, doors_at, status, onsale_at, ticket_limit, order_limit) VALUES (?,?,?,?, 'music', ?, ?, 'published', ?, ?, ?)",
    orgId, venue, tag, tag, new Date(Date.now() + 864e5).toISOString(), new Date(Date.now() + 864e5 - 36e5).toISOString(), new Date(Date.now() - 864e5).toISOString(), opts.limit ?? 8, opts.orderLimit ?? null)
  for (const name of ['General', 'Premium', 'VIP', 'Accessible']) run('INSERT INTO price_levels (event_id, name, price_cents, ticket_type) VALUES (?,?,10000,?)', ev, name, 'standard')
  inv.generateInventory(ev)
  const seat = (row: string, num: number) => (get<{ id: number }>('SELECT i.id FROM inventory i JOIN seats st ON st.id = i.seat_id WHERE i.event_id = ? AND st.row = ? AND st.number = ?', ev, row, num)).id
  return { ev, seat, venue }
}
const who = (t: string, userId: number | null = null) => ({ sessionToken: t, userId })
let k = 0
const pay = (holdId: number, session: string, o: { userId?: number | null; email?: string; last4?: string; key?: string } = {}) =>
  finalize({ holdId, sessionToken: session, userId: o.userId ?? null, email: o.email ?? 'g@x.test', key: o.key ?? `key-${++k}-padding`, method: 'card', brand: 'Visa', last4: o.last4 ?? '4242', exp: '12/39', save: false, billing: { name: 'G', address: 'a', city: 'c', zip: '1' } })
const orderId = (r: unknown) => (r as { orderId: number }).orderId
const count = (t: string) => get<{ n: number }>(`SELECT count(*) AS n FROM ${t}`).n
const itemSum = (id: number) => get<{ s: number }>('SELECT sum(unit_cents + fee_cents + tax_cents) AS s FROM order_items WHERE order_id = ?', id).s
const noOpts = { promo: '', offers: {}, addons: {} }

test('fee and tax math: per-ticket fee + facility, tax on face + fees, one order fee, delivery folded into it', () => {
  const rule = { service_pct: 10, facility_cents: 300, order_cents: 250, delivery_cents: 100 }
  const p = P.price([5000, 5000], rule, 1000)
  assert.deepEqual(p.lineFees, [800, 800])
  assert.deepEqual(p.lineTax, [580, 580]) // (5000 + 800) * 10%
  assert.equal(p.orderFee, 350)
  assert.equal(p.fees, 800 * 2 + 350)
  assert.equal(p.total, 10000 + p.fees + 1160)
  assert.equal(P.price([], rule, 1000).total, 0)
})

test('dynamic price: clamp(base x (1 + k x sold% + j x queue), min, max)', () => {
  const l = { price_cents: 10000, dyn_min_cents: 10000, dyn_max_cents: 15000, dyn_k: 1, dyn_j: 0 }
  assert.equal(P.dynamicPrice(l, { soldPct: 0, queueFactor: 0 }), 10000)
  assert.equal(P.dynamicPrice(l, { soldPct: 0.3, queueFactor: 0 }), 13000)
  assert.equal(P.dynamicPrice(l, { soldPct: 0.9, queueFactor: 0 }), 15000) // clamped to max
  assert.equal(P.dynamicPrice({ ...l, dyn_j: 0.3 }, { soldPct: 0.1, queueFactor: 1 }), 14000) // 10000 x (1 + .1 + .3)
  assert.equal(P.dynamicPrice({ ...l, dyn_j: 0.5 }, { soldPct: 0.2, queueFactor: 1 }), 15000) // 17000 clamped
  assert.equal(P.dynamicPrice({ ...l, dyn_k: 1, dyn_min_cents: 12000 }, { soldPct: 0, queueFactor: 0 }), 12000) // raised to min
  assert.equal(P.dynamicPrice({ ...l, dyn_k: null, dyn_max_cents: null }, { soldPct: 1, queueFactor: 1 }), 10000) // k = j = 0: fixed
})

test('platinum: price follows sold% and k, is locked at hold time and finalize charges the locked price', () => {
  const { ev, seat } = makeEvent()
  const plat = run("INSERT INTO price_levels (event_id, name, price_cents, ticket_type) VALUES (?, 'Platinum', 10000, 'platinum')", ev)
  db.prepare('UPDATE inventory SET price_level_id = ? WHERE id IN (SELECT i.id FROM inventory i JOIN seats st ON st.id = i.seat_id WHERE i.event_id = ? AND st.row = ?)').run(plat, ev, 'B')
  org.setDynamic(ev, plat, { min: '100', max: '250', k: '1', j: '' })
  const level = () => P.displayLevels(ev, false).find((l) => l.id === plat)!.cents

  assert.equal(level(), 10000) // nothing sold
  const first = inv.holdSeats(ev, who('plat1'), [seat('B', 1), seat('B', 2)])
  assert.equal(get<{ l: number }>('SELECT locked_cents AS l FROM inventory WHERE id = ?', seat('B', 1)).l, 10000)

  db.prepare("UPDATE inventory SET status = 'sold' WHERE id IN (SELECT i.id FROM inventory i JOIN seats st ON st.id = i.seat_id WHERE i.event_id = ? AND st.row = 'A' AND st.number <= 30)").run(ev) // 30 of 60 sold
  assert.equal(level(), 15000) // sold% 0.5, k 1
  assert.deepEqual(P.quote(first.holdId).lines.map((l) => l.unit), [10000, 10000]) // the open hold is untouched

  org.setDynamic(ev, plat, { min: '100', max: '250', k: '0.5', j: '' })
  assert.equal(level(), 12500) // changing k changes the price
  org.setDynamic(ev, plat, { min: '100', max: '120', k: '5', j: '' })
  assert.equal(level(), 12000) // clamped

  org.setDynamic(ev, plat, { min: '100', max: '250', k: '1', j: '' })
  const second = inv.holdSeats(ev, who('plat2'), [seat('B', 10), seat('B', 11)])
  assert.deepEqual(P.quote(second.holdId).lines.map((l) => l.unit), [15000, 15000])

  // the price then drifts again (more sold), but checkout uses what was locked
  db.prepare("UPDATE inventory SET status = 'sold' WHERE event_id = ? AND status = 'available'").run(ev)
  assert.equal(level(), 19333) // 56 of 60 sold
  const o = orderId(pay(first.holdId, 'plat1'))
  assert.equal(get<{ subtotal: number }>('SELECT subtotal FROM orders WHERE id = ?', o).subtotal, 20000)
  assert.equal(get<{ total: number }>('SELECT total FROM orders WHERE id = ?', o).total, itemSum(o))
  assert.throws(() => org.setDynamic(ev, plat, { min: '100', max: '', k: '1', j: '' }), UserError) // dynamic needs a maximum
})

test('fee rules: event rule overrides platform defaults; an admin default change shows in the next quote; tax per city', () => {
  const { ev, seat } = makeEvent()
  const h = inv.holdSeats(ev, who('fee1'), [seat('A', 1), seat('A', 2)])
  const base = P.quote(h.holdId)
  assert.equal(base.fees, 2 * (1000 + 300) + 250) // built-in defaults: 10% + $3.00 per ticket, $2.50 per order
  P.setFeeDefaults({ service_pct: 20, facility_cents: 0, order_cents: 100, delivery_cents: 50 })
  const changed = P.quote(h.holdId)
  assert.equal(changed.fees, 2 * 2000 + 150)
  assert.equal(changed.total, changed.subtotal + changed.fees + changed.tax)
  org.setFees(ev, { service_pct: 5, facility_cents: 100, order_cents: 0, delivery_cents: 0 }) // the event's own rule wins
  assert.equal(P.quote(h.holdId).fees, 2 * (500 + 100))
  assert.throws(() => P.setFeeDefaults({ service_pct: 99, facility_cents: 0, order_cents: 0, delivery_cents: 0 }), UserError)
  const before = P.quote(h.holdId).tax
  P.setCityTax(city, 2000)
  assert.equal(P.quote(h.holdId).tax, before * 2)
  P.setCityTax(city, 1000)
  db.prepare("DELETE FROM settings WHERE key = 'fee_defaults'").run()
  db.prepare('UPDATE events SET fee_rule = NULL WHERE id = ?').run(ev)
})

test('all-in display equals what checkout charges per ticket; off shows face value', () => {
  const { ev, seat } = makeEvent()
  const h = inv.holdSeats(ev, who('allin'), [seat('A', 5), seat('A', 6), seat('A', 7)])
  const q = P.quote(h.holdId)
  const ctx = P.pricingCtx(ev)
  const shownAll = q.lines.map((l) => P.shown(l.unit, ctx, true))
  assert.deepEqual(shownAll, q.lines.map((l) => l.unit + l.fee + l.tax))
  assert.equal(shownAll.reduce((a, b) => a + b) + q.orderFee, q.total)
  assert.deepEqual(q.lines.map((l) => P.shown(l.unit, ctx, false)), q.lines.map((l) => l.unit))
  assert.deepEqual(P.displayRange(ev, false), [10000, 10000])
  assert.deepEqual(P.displayRange(ev, true), [shownAll[0], shownAll[0]])
})

test('promo: pct and fixed, per-event/global, expiry, discount capped at subtotal, uses counted once in finalize', () => {
  const { ev, seat } = makeEvent()
  const other = makeEvent()
  const ins = (code: string, kind: string, amount: number, max: number, o: { org?: number | null; event?: number | null; exp?: string | null } = {}) =>
    run('INSERT INTO promo_codes (org_id, event_id, code, kind, amount, max_uses, expires_at) VALUES (?,?,?,?,?,?,?)', o.org ?? null, o.event ?? null, code, kind, amount, max, o.exp ?? null)
  ins('TEN', 'pct', 10, 2)
  ins('HUGE', 'fixed', 99_999_00, 5)
  ins('ONLYHERE', 'fixed', 500, 5, { event: ev })
  ins('OLD', 'pct', 10, 5, { exp: '2000-01-01T00:00:00Z' })
  const setup = (s: string, code: string, e = ev, seats = [seat('A', 1), seat('A', 2)]) => {
    const h = inv.holdSeats(e, who(s), seats)
    P.setCheckoutOptions(h.holdId, s, { ...noOpts, promo: code })
    return h.holdId
  }
  assert.throws(() => setup('pr0', 'NOPE'), /Unknown promo/)
  assert.throws(() => setup('pr0', 'OLD'), /expired/)
  assert.throws(() => setup('pr0', 'onlyhere', other.ev, [other.seat('A', 1), other.seat('A', 2)]), /Unknown promo/) // another event's code
  assert.ok(P.quote(setup('pr0', 'onlyhere')).discount === 500) // case-insensitive

  // discount can't exceed the ticket subtotal, and sum(items) still equals the total
  const huge = setup('pr1', 'HUGE', ev, [seat('A', 10), seat('A', 11)])
  const q = P.quote(huge)
  assert.equal(q.discount, q.subtotal)
  const ho = orderId(pay(huge, 'pr1'))
  assert.equal(itemSum(ho), get<{ total: number }>('SELECT total FROM orders WHERE id = ?', ho).total)
  assert.equal(get<{ discount: number }>('SELECT discount FROM orders WHERE id = ?', ho).discount, 20000)

  // limited to 2 uses: three shoppers pick it while it is still free, the third payment is refused and rolls back
  const a = setup('pr2', 'TEN', ev, [seat('A', 20), seat('A', 21)])
  const b = setup('pr3', 'TEN', ev, [seat('A', 22), seat('A', 23)])
  const c = setup('pr4', 'TEN', ev, [seat('B', 1), seat('B', 2)])
  assert.equal(P.quote(a).discount, 2000)
  const ra = pay(a, 'pr2', { key: 'promo-once-key' })
  assert.deepEqual(pay(a, 'pr2', { key: 'promo-once-key' }), ra)
  assert.equal(get<{ uses: number }>("SELECT uses FROM promo_codes WHERE code = 'TEN'").uses, 1) // a retried/replayed payment counts once
  assert.ok('orderId' in ra && 'orderId' in pay(b, 'pr3'))
  const orders = count('orders')
  assert.throws(() => pay(c, 'pr4'), /used up/)
  assert.equal(count('orders'), orders)
  assert.equal(get<{ uses: number }>("SELECT uses FROM promo_codes WHERE code = 'TEN'").uses, 2)
  assert.throws(() => setup('pr5', 'TEN', ev, [seat('B', 10), seat('B', 11)]), /used up/)
  assert.throws(() => db.prepare("UPDATE promo_codes SET uses = 3 WHERE code = 'TEN'").run()) // CHECK (uses <= max_uses)
})

test('offers: per-ticket percent off the locked face; fees follow the discounted price', () => {
  const { ev, seat } = makeEvent()
  org.setOffer(ev, 'child', '50')
  const child = get<{ id: number }>("SELECT id FROM offers WHERE event_id = ? AND name = 'child'", ev).id
  const h = inv.holdSeats(ev, who('off1'), [seat('A', 1), seat('A', 2)])
  const [l1, l2] = P.quote(h.holdId).lines
  P.setCheckoutOptions(h.holdId, 'off1', { ...noOpts, offers: { [l2.inventoryId]: child } })
  const q = P.quote(h.holdId)
  assert.deepEqual(q.lines.map((l) => l.unit), [10000, 5000])
  assert.equal(q.lines[1].fee, P.price([5000], P.pricingCtx(ev).rule, 1000).lineFees[0])
  assert.throws(() => P.setCheckoutOptions(h.holdId, 'off1', { ...noOpts, offers: { [l1.inventoryId]: 9999 } }), /Unknown offer/)
  assert.throws(() => P.setCheckoutOptions(h.holdId, 'someone-else', noOpts), /expired/)
  const o = orderId(pay(h.holdId, 'off1'))
  assert.equal(get<{ offer_id: number }>('SELECT offer_id FROM order_items WHERE order_id = ? AND offer_id IS NOT NULL', o).offer_id, child)
  assert.equal(itemSum(o), get<{ total: number }>('SELECT total FROM orders WHERE id = ?', o).total)
})

test('add-ons: atomic oversell guard (parking inventory 1), own SafeTix pass, scannable, sum(items) == total', () => {
  const { ev, seat } = makeEvent()
  const parking = run("INSERT INTO addons (event_id, kind, name, price_cents, inventory) VALUES (?, 'parking', 'Lot A', 3000, 1)", ev)
  const merch = run("INSERT INTO addons (event_id, kind, name, price_cents, inventory) VALUES (?, 'merch', 'Shirt', 2500, 10)", ev)
  run("INSERT INTO promo_codes (code, kind, amount, max_uses) VALUES ('P5', 'fixed', 500, 10)")
  const buy = (s: string, seats: number[], addons: Record<number, number>, promo = '') => {
    const h = inv.holdSeats(ev, who(s), seats)
    P.setCheckoutOptions(h.holdId, s, { promo, offers: {}, addons })
    return h.holdId
  }
  const a = buy('ad1', [seat('A', 1), seat('A', 2)], { [parking]: 1, [merch]: 2 }, 'P5')
  const b = buy('ad2', [seat('A', 10), seat('A', 11)], { [parking]: 1 }) // both saw 1 left
  const q = P.quote(a)
  assert.equal(q.subtotal, 20000 + 3000 + 5000)
  const oa = orderId(pay(a, 'ad1'))
  assert.equal(itemSum(oa), get<{ total: number }>('SELECT total FROM orders WHERE id = ?', oa).total)
  assert.equal(get<{ total: number }>('SELECT total FROM orders WHERE id = ?', oa).total, q.total)

  // second buyer: sold out, and nothing was created or charged
  const before = [count('orders'), count('payments'), count('tickets'), count('order_items')]
  assert.throws(() => pay(b, 'ad2'), /Lot A is sold out/)
  assert.deepEqual([count('orders'), count('payments'), count('tickets'), count('order_items')], before)
  assert.equal(get<{ sold: number }>('SELECT sold FROM addons WHERE id = ?', parking).sold, 1)
  assert.throws(() => P.setCheckoutOptions(b, 'ad2', { promo: '', offers: {}, addons: { [parking]: 1 } }), /sold out/)
  P.setCheckoutOptions(b, 'ad2', noOpts) // drops the add-on, and the seats are still held
  assert.ok('orderId' in pay(b, 'ad2'))

  // the parking unit became a pass: a ticket without a seat, with its own secret; merch got no pass
  const passes = db.prepare('SELECT id, secret, inventory_id, addon_id, status FROM tickets WHERE order_id = ? AND addon_id IS NOT NULL').all(oa) as { id: number; secret: string; inventory_id: number | null; addon_id: number; status: string }[]
  assert.equal(passes.length, 1)
  assert.equal(passes[0].inventory_id, null)
  assert.equal(passes[0].addon_id, parking)
  const seatTickets = get<{ n: number }>('SELECT count(*) AS n FROM tickets WHERE order_id = ? AND inventory_id IS NOT NULL', oa).n
  assert.equal(seatTickets, 2)
  const p = passes[0]
  assert.deepEqual(scanTicket(ev, makeToken(p.id, p.secret), scanner), { result: 'valid', message: 'Valid · Lot A', ticketId: p.id })
  assert.equal(scanTicket(ev, makeToken(p.id, p.secret), scanner).result, 'used')
  // every ticket is either a seat or an add-on pass, never neither
  assert.throws(() => db.prepare("INSERT INTO tickets (order_id, secret) VALUES (?, 'x')").run(oa)) // needs an inventory row or an addon
})

test('limits: per order, and per event across orders (account and same email)', () => {
  const { ev, seat } = makeEvent({ limit: 8, orderLimit: 5 })
  const user = run("INSERT INTO users (email, name, password_hash) VALUES ('lim@x.test','L','x')")
  const seats = (row: string, from: number, count: number) => Array.from({ length: count }, (_, i) => seat(row, from + i))
  // per order
  assert.throws(() => inv.holdSeats(ev, who('lim1', user), seats('A', 1, 6)), /1 to 5 tickets per order/)
  assert.throws(() => inv.holdBestAvailable(ev, who('lim1', user), 6), /1 to 5 tickets per order/)
  // per event: 5 + 3 fits, the ninth does not (two orders)
  assert.ok('orderId' in pay(inv.holdSeats(ev, who('lim1', user), seats('A', 1, 5)).holdId, 'lim1', { userId: user, email: 'lim@x.test' }))
  assert.throws(() => inv.holdSeats(ev, who('lim2', user), seats('A', 10, 4)), /Limit 8 tickets per account/) // 5 + 4 = 9
  const h = inv.holdSeats(ev, who('lim2', user), seats('A', 10, 3))
  assert.ok('orderId' in pay(h.holdId, 'lim2', { userId: user, email: 'lim@x.test' }))
  assert.throws(() => inv.holdSeats(ev, who('lim3', user), seats('A', 20, 1)), /Limit 8/)
  // a guest checking out with the same email is counted too
  const g = inv.holdSeats(ev, who('guest'), seats('A', 20, 2))
  assert.throws(() => pay(g.holdId, 'guest', { email: 'LIM@x.test' }), /Limit 8/)
})
