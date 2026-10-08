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
const { csvCell, reportCsv, settleEvent, eventReport } = await import('../lib/reports.ts')
const imp = await import('../lib/impersonation.ts')
const sup = await import('../lib/support.ts')
const { readFileSync } = await import('node:fs')
const { sendCampaign } = await import('../lib/campaign.ts')
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

test('CSV cells are escaped and formulas neutralised', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`)
  assert.equal(csvCell('+1'), "'+1")
  assert.equal(csvCell('-cmd'), "'-cmd")
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)")
  assert.equal(csvCell('a,b'), '"a,b"')
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"')
  assert.equal(csvCell(-500), '-500') // numbers are not prefixed
  assert.equal(csvCell(null), '')
})

test('report CSV totals match select sum(total); src shows in the marketing report; settlement is idempotent and zero-sum', () => {
  const e4 = mkEvent('e4', 5 * 864e5)
  const sess = (u: number, src?: string) => {
    const session = `s${++n}`
    const h = inv.holdBestAvailable(e4, { sessionToken: session, userId: u }, 2)
    const r = finalize({ holdId: h.holdId, sessionToken: session, userId: u, email: `=evil${u}@x.test`, key: `key-${n}-padding`, method: 'card', brand: 'Visa', last4: '4242', exp: '12/39', save: false, billing: { name: 'A', address: 'a', city: 'c', zip: '1' }, src })
    assert.ok('orderId' in r)
  }
  sess(alice, 'newsletter')
  sess(bob, 'Not A Slug!') // invalid slug is dropped
  sess(alice)
  const csv = reportCsv(e4)
  const lines = csv.trim().split('\r\n')
  assert.equal(lines.length, 1 + 3 + 1)
  const total = Number(lines.at(-1)!.split(',')[9])
  assert.equal(total, get<{ s: number }>("SELECT sum(total) AS s FROM orders WHERE event_id = ?", e4).s)
  assert.ok(lines[1].includes("\"'=evil") || lines[1].includes("'=evil")) // email starting with = is prefixed
  const rep = eventReport(e4, 'UTC')
  assert.equal(rep.gross, total)
  assert.deepEqual(rep.bySrc.map((s) => [s.src, s.orders]).sort(), [['direct', 2], ['newsletter', 1]])
  assert.equal(rep.byLevel.reduce((a, l) => a + l.sold, 0), 6)
  // not over yet
  assert.throws(() => settleEvent(e4, admin), /not over/)
  db.prepare('UPDATE events SET starts_at = ? WHERE id = ?').run(new Date(Date.now() - 864e5).toISOString(), e4)
  const before = ledgerTotal()
  const first = settleEvent(e4, admin)
  assert.equal(first.settled, true)
  assert.equal(first.net, rep.net)
  assert.equal(balance(`org:${org}`), rep.net)
  const second = settleEvent(e4, admin)
  assert.equal(second.settled, false)
  assert.equal(balance(`org:${org}`), rep.net) // credited once
  assert.equal(get<{ n: number }>("SELECT count(*) AS n FROM ledger WHERE ref = ?", `settle:event:${e4}`).n >= 3, true)
  assert.equal(ledgerTotal(), before)
  assert.equal(ledgerTotal(), 0)
  // the org can request a payout of it
  requestPayout(`org:${org}`, alice, rep.net)
  assert.equal(balance(`org:${org}`), 0)
})

test('settlement waits for orders in review', () => {
  const e5 = mkEvent('e5', 5 * 864e5)
  const [t] = buy(alice, e5)
  db.prepare("UPDATE orders SET status = 'review' WHERE id = (SELECT order_id FROM tickets WHERE id = ?)").run(t)
  db.prepare('UPDATE events SET starts_at = ? WHERE id = ?').run(new Date(Date.now() - 864e5).toISOString(), e5)
  assert.throws(() => settleEvent(e5, admin), /Resolve 1/)
})

test('campaign goes only to opted-in fans, with an unsubscribe footer, and is rate limited', () => {
  const e6 = mkEvent('e6', 5 * 864e5)
  const carol = user('carol')
  buy(alice, e6)
  buy(bob, e6)
  db.prepare("UPDATE users SET notif_prefs = '{\"marketing_email\":true}' WHERE id = ?").run(alice) // only alice opted in
  const r = sendCampaign(e6, 'Hello', 'Doors at 7')
  assert.deepEqual(r, { sent: 1, skipped: 1 })
  const mail = get<{ to: string; body: string }>("SELECT \"to\", body FROM outbox WHERE subject = 'Hello'")
  assert.equal(mail.to, 'alice@x.test')
  assert.match(mail.body, /Unsubscribe from these emails: .*\/unsubscribe\?t=/)
  assert.ok(carol)
  sendCampaign(e6, 'Two', 'x')
  sendCampaign(e6, 'Three', 'x')
  assert.throws(() => sendCampaign(e6, 'Four', 'x'), /per event per day/)
  assert.throws(() => sendCampaign(e6, '', 'x'), /Subject/)
})

test('impersonation: admin only, audited start and stop, restrictions apply to the session', () => {
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin)
  const admin2 = user('admin2')
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin2)
  assert.throws(() => imp.startSession(alice, bob), /Only admins/) // a fan cannot
  assert.throws(() => imp.startSession(admin, admin2), /Admins cannot/)
  assert.throws(() => imp.startSession(admin, admin), /Admins cannot/)
  const token = imp.startSession(admin, bob)
  const row = get<{ user_id: number; impersonator_id: number; expires_at: string }>('SELECT user_id, impersonator_id, expires_at FROM sessions WHERE token = ?', token)
  assert.equal(row.user_id, bob)
  assert.equal(row.impersonator_id, admin)
  assert.ok(Date.parse(row.expires_at) - Date.now() <= imp.IMPERSONATION_MS)
  assert.equal(imp.isImpersonating(token), true)
  assert.throws(() => imp.assertNotImpersonating(token), /Not available/) // the check requireSelf runs on the session token
  imp.assertNotImpersonating('some-normal-session') // no throw
  assert.equal(get<{ n: number }>("SELECT count(*) AS n FROM audit_log WHERE action = 'impersonate.start' AND actor_id = ?", admin).n, 1)
  assert.equal(imp.endSession(token), admin)
  assert.equal(get<{ n: number }>("SELECT count(*) AS n FROM audit_log WHERE action = 'impersonate.stop' AND actor_id = ?", admin).n, 1)
  assert.equal(imp.isImpersonating(token), false)
  assert.equal(imp.endSession(token), undefined) // already over: no second audit row
  // the guards that matter use requireSelf (which refuses an impersonating session), never plain requireUser
  const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
  const acct = read('app/account/actions.ts')
  assert.ok(!acct.includes('requireUser'), 'account actions (password, 2FA, cards, payouts) must use requireSelf')
  const sess = read('lib/session.ts')
  assert.match(sess, /export async function refuseImpersonation[\s\S]*?assertNotImpersonating\(/) // requireSelf -> refuseImpersonation -> assertNotImpersonating
  assert.match(sess, /export async function requireSelf[\s\S]*?refuseImpersonation\(\)/)
  assert.match(sess, /requireAdmin[\s\S]*?requireSelf\(\)/)
  assert.match(sess, /requireOrgRole[\s\S]*?requireSelf\(\)/)
})

test('every exported admin and organizer action writes the audit log', () => {
  for (const f of ['app/admin/actions.ts', 'app/organizer/actions.ts']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
    const bodies = src.split(/^export async function /m).slice(1)
    for (const b of bodies) {
      const name = b.slice(0, b.indexOf('('))
      if (name === 'impersonateUser') continue // audited inside lib/impersonation.ts (tested above)
      assert.ok(b.includes('audit('), `${f}: ${name} has no audit() call`)
    }
  }
})

test('support: staff reply is appended, emailed, visible to the owner only; follow-ups reopen', () => {
  const id = sup.createContact(alice, 'alice@x.test', 'Lost ticket', 'Where is my ticket?')
  sup.addMessage(id, { staff: true, name: 'Ada' }, 'Check My tickets.')
  const t = sup.getSupportTicket(id)!
  assert.equal(t.status, 'answered')
  assert.equal(t.messages.length, 2)
  assert.equal(t.messages[1].staff, true)
  assert.match(get<{ body: string }>("SELECT body FROM outbox WHERE subject LIKE ? ORDER BY id DESC", `Re: Lost ticket%`).body, /Check My tickets/)
  assert.equal(get<{ n: number }>("SELECT count(*) AS n FROM notifications WHERE user_id = ? AND kind = 'support'", alice).n, 1)
  assert.throws(() => sup.addMessage(id, { staff: false, userId: bob }, 'hi'), /not found/)
  sup.addMessage(id, { staff: false, userId: alice }, 'Thanks')
  assert.equal(sup.getSupportTicket(id)!.status, 'open')
  sup.closeTicket(id)
  assert.throws(() => sup.addMessage(id, { staff: false, userId: alice }, 'again'), /closed/)
})

test('impersonation: money, ticket and listing actions are all guarded', () => {
  const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
  for (const f of ['app/tickets/exchange-actions.ts', 'app/transfers/actions.ts', 'app/resale/actions.ts', 'app/support/actions.ts']) assert.ok(!read(f).includes('requireUser'), `${f} must use requireSelf`)
  assert.match(read('app/checkout/actions.ts'), /export async function pay[\s\S]*?impersonator_id/) // no purchases, no saved-card charges
  const orders = read('app/orders/actions.ts')
  for (const fn of ['requestRefund', 'fileClaim']) assert.match(orders, new RegExp(`export async function ${fn}[^]*?refuseImpersonation`))
})

test('refunds after settlement reverse the ledger; org cannot draw more than its balance; resale refund reverses its group', async () => {
  const { refundOrder, refundEvent } = await import('../lib/orders.ts')
  const e7 = mkEvent('e7', 5 * 864e5)
  const ta = buy(alice, e7)[0]
  buy(bob, e7)
  db.prepare('UPDATE events SET starts_at = ? WHERE id = ?').run(new Date(Date.now() - 864e5).toISOString(), e7)
  const oid = (t: number) => get<{ order_id: number }>('SELECT order_id FROM tickets WHERE id = ?', t).order_id
  const s = settleEvent(e7, admin)
  const orgBefore = balance(`org:${org}`)
  assert.equal(orgBefore, s.net)
  // partial-order refund after settlement: alice's whole order (5000 face + fees + tax)
  const total = get<{ total: number; fees: number; tax: number }>('SELECT total, fees, tax FROM orders WHERE id = ?', oid(ta))
  refundOrder(oid(ta), { reason: 'test' })
  assert.equal(ledgerTotal(), 0)
  assert.equal(balance(`org:${org}`), orgBefore - 5000) // the face share, exactly what the org was paid for that order
  assert.equal(get<{ s: number }>("SELECT sum(amount) AS s FROM ledger WHERE ref LIKE 'refund:payment:%' AND account = 'cash'").s, total.total)
  assert.throws(() => refundOrder(oid(ta), { reason: 'again' }), /cannot be refunded/) // no second refund, no second reversal
  // the event is then cancelled: bob's order is reversed too, alice's not twice
  refundEvent(e7)
  assert.equal(ledgerTotal(), 0)
  assert.equal(balance(`org:${org}`), orgBefore - 10000)
  assert.equal(get<{ n: number }>("SELECT count(*) AS n FROM ledger WHERE ref LIKE 'refund:payment:%' AND account = 'cash'").n, 2)
  // the org is overdrawn: it cannot request anything
  assert.throws(() => requestPayout(`org:${org}`, alice, 1), /at most/)
  // refunding ONE resale order reverses its listing group (seller keeps nothing)
  const e8 = mkEvent('e8', 5 * 864e5)
  const [t] = buy(alice, e8)
  const lid = createListing(alice, t, 6000)
  const before = balance(`user:${alice}`)
  const h = holdListing(lid, { sessionToken: 'bob-e8', userId: bob })
  const r = finalize({ holdId: h.holdId, sessionToken: 'bob-e8', userId: bob, email: 'bob@x.test', key: 'p11-e8-key', method: 'card', brand: 'Visa', last4: '4242', exp: '12/39', save: false, billing: { name: 'B', address: 'a', city: 'c', zip: '1' } })
  assert.ok('orderId' in r)
  assert.equal(balance(`user:${alice}`), before + 5400)
  refundOrder((r as { orderId: number }).orderId, { reason: 'test' })
  assert.equal(balance(`user:${alice}`), before)
  assert.equal(ledgerTotal(), 0)
  refundEvent(e8) // no second reversal
  assert.equal(balance(`user:${alice}`), before)
  assert.equal(ledgerTotal(), 0)
})
