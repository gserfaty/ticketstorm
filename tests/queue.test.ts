import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'ticketstorm-'))
process.env.TICKETSTORM_DB = join(dir, 'test.db')
const { db } = await import('../lib/db.ts')
const q = await import('../lib/queue.ts')
const d = await import('../lib/defense.ts')
test.after(() => rmSync(dir, { recursive: true, force: true }))

const run = (sql: string, ...a: (string | number | null)[]) => Number(db.prepare(sql).run(...a).lastInsertRowid)
const orgId = run("INSERT INTO orgs (name, status) VALUES ('T','approved')")
const cityId = run("INSERT INTO cities (name, state, lat, lng) VALUES ('X','XX',0,0)")
const venueId = run("INSERT INTO venues (org_id, slug, name, address, city_id, lat, lng, tz) VALUES (?, 'v', 'V', 'a', ?, 0, 0, 'UTC')", orgId, cityId)
const T0 = Date.parse('2030-01-01T12:00:00Z') // the fake clock: every call passes `now`
const MIN = 60_000
let n = 0
const makeEvent = (rate: number, cap: number) =>
  run(
    `INSERT INTO events (org_id, venue_id, slug, title, category, starts_at, status, onsale_at, queue_enabled, queue_rate, queue_cap) VALUES (?,?,?,?, 'music', '2031-01-01T00:00:00Z', 'published', ?, 1, ?, ?)`,
    orgId, venueId, `q${n}`, `q${n++}`, new Date(T0 + 60 * MIN).toISOString(), rate, cap,
  )
const admitted = (ev: number) => Number((db.prepare('SELECT count(*) AS n FROM queue_entries WHERE event_id = ? AND admitted_at IS NOT NULL').get(ev) as { n: number }).n)

test('pre-onsale joins get random places; rejoining keeps yours; rate admits in rank order', () => {
  const ev = makeEvent(10, 1000)
  for (let i = 0; i < 100; i++) q.joinQueue(ev, `s${i}`, null, T0 + i)
  const order = (db.prepare('SELECT session_token AS t FROM queue_entries WHERE event_id = ? ORDER BY rank, id').all(ev) as { t: string }[]).map((r) => r.t)
  assert.equal(order.length, 100)
  assert.notDeepEqual(order, Array.from({ length: 100 }, (_, i) => `s${i}`), 'join order must not decide the place')

  const before = db.prepare('SELECT rank FROM queue_entries WHERE event_id = ? AND session_token = ?').get(ev, 's7')
  q.joinQueue(ev, 's7', null, T0 + 5000) // refresh / rejoin
  assert.deepEqual(db.prepare('SELECT rank FROM queue_entries WHERE event_id = ? AND session_token = ?').get(ev, 's7'), before)
  assert.equal(admitted(ev) + (db.prepare('SELECT count(*) AS n FROM queue_entries WHERE event_id = ?').get(ev) as { n: number }).n, 100)

  q.queueStatus(ev, 's0', T0 + 59 * MIN)
  assert.equal(admitted(ev), 0, 'nobody is admitted before on-sale')
  assert.equal(q.queueStatus(ev, 'nobody', T0).state, 'none')

  assert.equal(q.queueStatus(ev, order[99], T0 + 61 * MIN).state, 'waiting')
  assert.equal(admitted(ev), 10, 'rate 10/min -> 10 after 1 minute')
  assert.deepEqual((db.prepare('SELECT session_token AS t FROM queue_entries WHERE event_id = ? AND admitted_at IS NOT NULL ORDER BY rank, id').all(ev) as { t: string }[]).map((r) => r.t), order.slice(0, 10))
  const st = q.queueStatus(ev, order[19], T0 + 61 * MIN)
  assert.equal(st.state === 'waiting' && st.position, 10, 'position counts the people still ahead')
  assert.equal(q.queueStatus(ev, order[0], T0 + 61 * MIN).state, 'admitted')
  q.queueStatus(ev, order[0], T0 + 62 * MIN)
  assert.equal(admitted(ev), 20)
})

test('cap limits shoppers inside at once; expiry frees slots; post-onsale joins are FIFO', () => {
  const ev = makeEvent(100, 5)
  const onsale = T0 + 60 * MIN
  for (let i = 0; i < 12; i++) q.joinQueue(ev, `c${i}`, null, onsale + 1000 + i)
  const ranks = (db.prepare('SELECT session_token AS t FROM queue_entries WHERE event_id = ? ORDER BY rank').all(ev) as { t: string }[]).map((r) => r.t)
  assert.deepEqual(ranks, Array.from({ length: 12 }, (_, i) => `c${i}`))

  q.queueStatus(ev, 'c0', onsale + 5 * MIN)
  assert.equal(admitted(ev), 5, 'rate would allow 500, cap allows 5')
  assert.equal(q.isAdmitted(ev, 'c4', onsale + 5 * MIN), true)
  assert.equal(q.isAdmitted(ev, 'c5', onsale + 5 * MIN), false)

  const later = onsale + 5 * MIN + (q.ADMIT_MINUTES + 1) * MIN // the first five ran out of time
  assert.equal(q.isAdmitted(ev, 'c0', later), false)
  assert.equal(q.queueStatus(ev, 'c0', later).state, 'expired')
  assert.equal(q.isAdmitted(ev, 'c5', later), true)
  assert.equal(admitted(ev), 10)
  q.joinQueue(ev, 'c0', null, later) // expired shoppers rejoin at the back
  assert.equal(q.queueStatus(ev, 'c0', later).state, 'waiting')
})

test('rate limit counter, single-use captcha and blocklist', () => {
  for (let i = 0; i < 5; i++) assert.equal(d.hit('k', 5, 60_000, T0), true)
  assert.equal(d.hit('k', 5, 60_000, T0 + 1), false, 'the 6th hit in a window is refused')
  assert.equal(d.hit('k', 5, 60_000, T0 + 61_000), true, 'a new window starts fresh')

  const c = d.newCaptcha(T0)
  const [a, b] = c.question.split(' + ').map(Number)
  assert.equal(d.checkCaptcha(c.token, String(a + b + 1), T0), false, 'wrong answer')
  assert.equal(d.checkCaptcha(c.token, String(a + b), T0), false, 'one attempt per token, even after a wrong answer')
  const c2 = d.newCaptcha(T0)
  const [a2, b2] = c2.question.split(' + ').map(Number)
  assert.equal(d.checkCaptcha(c2.token, String(a2 + b2), T0), true)
  assert.equal(d.checkCaptcha(c2.token, String(a2 + b2), T0), false, 'replay refused')
  const c3 = d.newCaptcha(T0)
  assert.equal(d.checkCaptcha(c3.token.replace(/.$/, (x) => (x === '0' ? '1' : '0')), '4', T0), false, 'tampered token')
  assert.equal(d.checkCaptcha(c3.token, '4', T0 + 11 * MIN), false, 'expired token')

  run("INSERT INTO blocklist (kind, value) VALUES ('ip', '9.9.9.9')")
  run("INSERT INTO blocklist (kind, value) VALUES ('email', 'bot@x.test')")
  assert.equal(d.isBlocked('9.9.9.9'), true)
  assert.equal(d.isBlocked('1.1.1.1', 'BOT@x.test'), true)
  assert.equal(d.isBlocked('1.1.1.1', 'ok@x.test'), false)
})
