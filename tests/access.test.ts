import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'ticketstorm-'))
process.env.TICKETSTORM_DB = join(dir, 'test.db')
const { db } = await import('../lib/db.ts')
const inv = await import('../lib/inventory.ts')
const acc = await import('../lib/access.ts')
const q = await import('../lib/queue.ts')
const { UserError } = await import('../lib/platform.ts')
test.after(() => rmSync(dir, { recursive: true, force: true }))

const run = (sql: string, ...a: (string | number | null)[]) => Number(db.prepare(sql).run(...a).lastInsertRowid)
const orgId = run("INSERT INTO orgs (name, status) VALUES ('T','approved')")
const cityId = run("INSERT INTO cities (name, state, lat, lng) VALUES ('X','XX',0,0)")
const venueId = run("INSERT INTO venues (org_id, slug, name, address, city_id, lat, lng, tz) VALUES (?, 'v', 'V', 'a', ?, 0, 0, 'UTC')", orgId, cityId)
const secId = run("INSERT INTO sections (venue_id, name, kind, path, label_x, label_y, rank) VALUES (?, 'A', 'reserved', '', 0, 0, 1)", venueId)
for (let r = 0; r < 4; r++) for (let n = 1; n <= 8; n++) run('INSERT INTO seats (section_id, row, number, x, y) VALUES (?,?,?,0,0)', secId, 'R' + r, n)
let k = 0
const makeEvent = (limit = 8, queue = 0) => {
  const ev = run(
    `INSERT INTO events (org_id, venue_id, slug, title, category, starts_at, status, onsale_at, ticket_limit, queue_enabled, queue_rate, queue_cap) VALUES (?,?,?,?, 'music', ?, 'published', ?, ?, ?, 1000, 1000)`,
    orgId, venueId, `e${k}`, `e${k++}`, new Date(Date.now() + 864e5 * 30).toISOString(), new Date(Date.now() - 864e5).toISOString(), limit, queue,
  )
  for (const [name, type] of [['General', 'standard'], ['Premium', 'standard'], ['VIP', 'vip'], ['Accessible', 'accessible'], ['Standing', 'standing']]) run('INSERT INTO price_levels (event_id, name, price_cents, ticket_type) VALUES (?,?,1000,?)', ev, name, type)
  inv.generateInventory(ev)
  return ev
}
const hour = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()
const window = (ev: number, o: Partial<Parameters<typeof acc.addWindow>[1]> = {}) =>
  acc.addWindow(ev, { name: 'Fan club', kind: 'fanclub', startsAt: hour(-1), endsAt: hour(24), requiresCode: true, regStarts: null, regEnds: null, slots: 0, buyBy: null, ...o })
const guest = (t: string) => ({ sessionToken: t, userId: null })
const user = (email: string, phone: string | null = null) => run('INSERT INTO users (email, name, password_hash, phone) VALUES (?,?,?,?)', email, email, 'x', phone)
const seat = (ev: number, row: string, n: number) => (db.prepare('SELECT i.id FROM inventory i JOIN seats s ON s.id = i.seat_id WHERE i.event_id = ? AND s.row = ? AND s.number = ?').get(ev, row, n) as { id: number }).id

test('presale seats: unavailable and unholdable without a code, holdable with one; uses are capped', () => {
  const ev = makeEvent()
  const w = window(ev)
  assert.equal(acc.assignWindow(ev, w, secId, 'R0'), 8)
  acc.generateCodes(ev, w, 1, 2)
  const code = (db.prepare('SELECT code FROM access_codes WHERE window_id = ?').get(w) as { code: string }).code
  const s = seat(ev, 'R0', 1)
  const state = (windows: number[]) => inv.getAvailability(ev, windows).seats.find((x) => x[0] === s)![1]

  assert.equal(state([]), 'b', 'public map shows it as not for sale')
  assert.throws(() => inv.holdSeats(ev, guest('a'), [s]), /taken/)
  assert.throws(() => acc.redeemCode(ev, 'a', null, 'WRONG'), UserError)

  acc.redeemCode(ev, 'a', null, code.toLowerCase())
  assert.deepEqual(acc.openWindowIds(ev, 'a'), [w])
  assert.deepEqual(acc.openWindowIds(ev, 'b'), [], 'unlock belongs to the session that entered the code')
  assert.equal(state(acc.openWindowIds(ev, 'a')), 'a')
  assert.equal(state(acc.openWindowIds(ev, 'b')), 'b')
  assert.throws(() => inv.holdSeats(ev, guest('b'), [s]), /taken/)
  inv.holdSeats(ev, guest('a'), [s])

  acc.redeemCode(ev, 'a', null, code) // same session again: free
  acc.redeemCode(ev, 'b', null, code)
  assert.throws(() => acc.redeemCode(ev, 'c', null, code), /used up/)
  assert.equal((db.prepare('SELECT uses FROM access_codes WHERE code = ?').get(code) as { uses: number }).uses, 2)
})

test('presale windows only work while open, and unsold seats go public when they end', () => {
  const ev = makeEvent()
  const w = window(ev, { startsAt: hour(2), endsAt: hour(3) })
  acc.assignWindow(ev, w, secId, 'R1')
  acc.generateCodes(ev, w, 1, 5)
  const code = (db.prepare('SELECT code FROM access_codes WHERE window_id = ?').get(w) as { code: string }).code
  assert.throws(() => acc.redeemCode(ev, 'a', null, code), /not started/)
  db.prepare('UPDATE onsale_windows SET starts_at = ?, ends_at = ? WHERE id = ?').run(hour(-2), hour(-1), w)
  assert.throws(() => acc.redeemCode(ev, 'a', null, code), /ended/)
  assert.throws(() => inv.holdSeats(ev, guest('a'), [seat(ev, 'R1', 1)]), /taken/, 'closed window stays locked until released')
  acc.releaseEndedWindows()
  inv.holdSeats(ev, guest('a'), [seat(ev, 'R1', 1)])
})

test('waiting room gates every hold path', () => {
  const ev = makeEvent(8, 1)
  assert.throws(() => inv.holdSeats(ev, guest('w'), [seat(ev, 'R2', 1)]), (e: Error & { status?: number }) => e.status === 403)
  assert.throws(() => inv.holdBestAvailable(ev, guest('w'), 2), (e: Error & { status?: number }) => e.status === 403)
  q.joinQueue(ev, 'w', null)
  assert.equal(q.queueStatus(ev, 'w').state, 'admitted', 'rate 1000/min, event already on sale')
  inv.holdSeats(ev, guest('w'), [seat(ev, 'R2', 1)])
  assert.throws(() => inv.holdSeats(ev, guest('x'), [seat(ev, 'R2', 2)]), (e: Error & { status?: number }) => e.status === 403)
})

test('ticket_limit counts the account across paid orders and other sessions\' holds', () => {
  const ev = makeEvent(4)
  const u = user('limit@x.test')
  const as = (t: string) => ({ sessionToken: t, userId: u })
  const buy = (t: string, qty: number) => {
    const h = inv.holdBestAvailable(ev, as(t), qty)
    const o = run("INSERT INTO orders (user_id, session_token, access_token, email, event_id, hold_id, status, subtotal, fees, tax, total, idempotency_key) VALUES (?,?,?,?,?,?, 'paid', 0,0,0,0,?)", u, t, t + k, 'x', ev, h.holdId, t + k++)
    for (const id of h.ids) run("INSERT INTO order_items (order_id, kind, inventory_id, unit_cents, fee_cents, tax_cents) VALUES (?, 'ticket', ?, 0,0,0)", o, id)
    db.prepare("UPDATE holds SET status = 'converted' WHERE id = ?").run(h.holdId)
    db.prepare("UPDATE inventory SET status = 'sold', held_until = NULL WHERE hold_id = ?").run(h.holdId)
  }
  buy('s1', 3)
  assert.throws(() => inv.holdBestAvailable(ev, as('s2'), 2), /Limit 4/)
  inv.holdBestAvailable(ev, as('s2'), 1)
  assert.throws(() => inv.holdBestAvailable(ev, as('s3'), 1), /Limit 4/, 'another session\'s live hold counts too')
  inv.holdBestAvailable(ev, as('s2'), 1) // replacing your own hold does not double count
})

test('Verified Fan lottery runs once, codes unlock the presale, waitlist is promoted when selected fans do not buy', () => {
  const ev = makeEvent()
  const w = window(ev, { kind: 'verified_fan', startsAt: hour(1), endsAt: hour(24), regStarts: hour(-5), regEnds: hour(-1), slots: 2, buyBy: hour(2) })
  acc.assignWindow(ev, w, secId, 'R3')
  const users = [1, 2, 3, 4].map((i) => user(`vf${i}@x.test`, `+1555000${i}`))
  for (const u of users) db.prepare('INSERT INTO vf_registrations (window_id, user_id) VALUES (?,?)').run(w, u)
  assert.throws(() => acc.registerVf(w, users[0]), /closed/)

  acc.runLottery()
  acc.runLottery() // idempotent
  const st = (s: string) => (db.prepare('SELECT user_id FROM vf_registrations WHERE window_id = ? AND status = ?').all(w, s) as { user_id: number }[]).map((r) => r.user_id)
  assert.equal(st('selected').length, 2)
  assert.equal(st('waitlisted').length, 2)
  assert.equal((db.prepare('SELECT count(*) AS n FROM access_codes WHERE window_id = ?').get(w) as { n: number }).n, 2)
  for (const u of st('selected')) {
    const { email } = db.prepare('SELECT email FROM users WHERE id = ?').get(u) as { email: string }
    assert.ok(db.prepare("SELECT 1 FROM outbox WHERE channel = 'email' AND \"to\" = ? AND body LIKE '%VF-%'", ).get(email))
    assert.ok(db.prepare("SELECT 1 FROM outbox WHERE channel = 'sms' AND body LIKE '%VF-%'").get())
  }

  const [a, b] = st('selected')
  const codeOf = (u: number) => (db.prepare('SELECT code FROM vf_registrations WHERE window_id = ? AND user_id = ?').get(w, u) as { code: string }).code
  db.prepare('UPDATE onsale_windows SET starts_at = ? WHERE id = ?').run(hour(-1), w)
  assert.throws(() => acc.redeemCode(ev, 's', null, codeOf(a)), /Log in/)
  assert.throws(() => acc.redeemCode(ev, 's', b, codeOf(a)), /another account/)
  acc.redeemCode(ev, 's', a, codeOf(a))
  const held = inv.holdSeats(ev, { sessionToken: 's', userId: a }, [seat(ev, 'R3', 1)])

  // a buys; b does not. After the buy-by time b's code dies and one waitlisted fan gets one.
  run("INSERT INTO orders (user_id, session_token, access_token, email, event_id, hold_id, status, subtotal, fees, tax, total, idempotency_key) VALUES (?, 's', 'tok', 'x', ?, ?, 'paid', 0,0,0,0,'k-vf')", a, ev, held.holdId)
  db.prepare('UPDATE onsale_windows SET vf_buy_by = ? WHERE id = ?').run(hour(-0.5), w)
  const waiting = (db.prepare("SELECT user_id FROM vf_registrations WHERE window_id = ? AND status = 'waitlisted' ORDER BY lottery_rank").all(w) as { user_id: number }[]).map((r) => r.user_id)
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES ('bsess', ?, '2099-01-01')").run(b)
  db.prepare("INSERT INTO window_unlocks (window_id, session_token) VALUES (?, 'bsess')").run(w)
  acc.promoteWaitlist()
  acc.promoteWaitlist()
  assert.deepEqual(st('expired'), [b], 'selected fan who missed the cutoff is expired, not waitlisted')
  assert.ok(st('selected').includes(waiting[0]), 'promotion follows the lottery order')
  assert.equal(db.prepare("SELECT 1 FROM window_unlocks WHERE session_token = 'bsess'").get(), undefined, 'their unlock is revoked')
  assert.equal(st('selected').length, 2, 'a stays selected; one waitlisted fan took b\'s place')
  assert.ok(!st('selected').includes(b))
  assert.throws(() => acc.redeemCode(ev, 'fresh', b, codeOf(a)), /another account/)
  assert.equal((db.prepare('SELECT count(*) AS n FROM access_codes WHERE window_id = ?').get(w) as { n: number }).n, 3)
})

test('a presale works on a queue-enabled event without queue admission, but only for window seats', () => {
  const ev = makeEvent(8, 1)
  db.prepare('UPDATE events SET onsale_at = ? WHERE id = ?').run(hour(5), ev) // public sale not started; waiting room would not admit yet
  const w = window(ev)
  acc.assignWindow(ev, w, secId, 'R0')
  acc.generateCodes(ev, w, 1, 1)
  const code = (db.prepare('SELECT code FROM access_codes WHERE window_id = ?').get(w) as { code: string }).code
  assert.throws(() => inv.holdSeats(ev, guest('p'), [seat(ev, 'R0', 1)]), (e: Error & { status?: number }) => e.status === 403)
  acc.redeemCode(ev, 'p', null, code)
  assert.throws(() => inv.holdSeats(ev, guest('p'), [seat(ev, 'R1', 1)]), /taken/, 'public seats stay closed')
  inv.holdSeats(ev, guest('p'), [seat(ev, 'R0', 1)])
  assert.equal(inv.holdBestAvailable(ev, guest('p'), 2).ids.every((id) => (db.prepare('SELECT window_id FROM inventory WHERE id = ?').get(id) as { window_id: number }).window_id === w), true)
})

test('ticket_limit also counts paid tickets bought with the same email (guest or logged in)', () => {
  const ev = makeEvent(2)
  const o = run("INSERT INTO orders (user_id, session_token, access_token, email, event_id, hold_id, status, subtotal, fees, tax, total, idempotency_key) VALUES (NULL,'g','t','Dupe@X.test',?,?, 'paid', 0,0,0,0,'k-email')", ev, run("INSERT INTO holds (session_token, event_id, expires_at, status) VALUES ('g', ?, '2099-01-01', 'converted')", ev))
  for (const id of [seat(ev, 'R0', 1), seat(ev, 'R0', 2)]) run("INSERT INTO order_items (order_id, kind, inventory_id, unit_cents, fee_cents, tax_cents) VALUES (?, 'ticket', ?, 0,0,0)", o, id)
  assert.throws(() => inv.assertTicketLimit(null, ev, 1, 'other', 'dupe@x.test'), /Limit 2/)
  assert.throws(() => inv.assertTicketLimit(user('dupe-user@x.test'), ev, 1, 'other', 'DUPE@x.test'), /Limit 2/)
  inv.assertTicketLimit(null, ev, 1, 'other', 'someone@else.test')
})

test('a logged-in user cannot hold two places in the same waiting room', () => {
  const ev = makeEvent(8, 1)
  db.prepare('UPDATE events SET onsale_at = ? WHERE id = ?').run(hour(5), ev)
  const u = user('twice@x.test')
  q.joinQueue(ev, 'browser1', u)
  q.joinQueue(ev, 'browser2', u)
  assert.equal((db.prepare('SELECT count(*) AS n FROM queue_entries WHERE event_id = ?').get(ev) as { n: number }).n, 1)
  assert.equal(q.queueStatus(ev, 'browser2').state, 'waiting', 'the latest browser holds the place')
  assert.equal(q.queueStatus(ev, 'browser1').state, 'none')
})

test('ending a window only frees available seats', () => {
  const ev = makeEvent()
  const w = window(ev)
  acc.assignWindow(ev, w, secId, 'R2')
  acc.generateCodes(ev, w, 1, 1)
  acc.redeemCode(ev, 'h', null, (db.prepare('SELECT code FROM access_codes WHERE window_id = ?').get(w) as { code: string }).code)
  const held = inv.holdSeats(ev, guest('h'), [seat(ev, 'R2', 1)])
  db.prepare('UPDATE onsale_windows SET ends_at = ? WHERE id = ?').run(hour(-1), w)
  acc.releaseEndedWindows()
  const win = (id: number) => (db.prepare('SELECT window_id FROM inventory WHERE id = ?').get(id) as { window_id: number | null }).window_id
  assert.equal(win(held.ids[0]), w, 'held seat keeps its window')
  assert.equal(win(seat(ev, 'R2', 2)), null)
})
