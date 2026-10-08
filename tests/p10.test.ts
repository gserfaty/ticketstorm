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
const { buildIcs, fold, icsDate, icsEscape } = await import('../lib/ics.ts')
const { alertUser, runAlerts, unsubToken, unsubscribe, verifyUnsub, emailUser } = await import('../lib/alerts.ts')
const { runJobs } = await import('../lib/jobs.ts')
const { prefsOf, saveAlertArea } = await import('../lib/account.ts')
const { toggleFavorite } = await import('../lib/favorites.ts')
const organizerLib = await import('../lib/organizer.ts')
const { publishEvent, createEvent } = organizerLib
const { parseFilters, searchEvents, score, recommendedEvents } = await import('../lib/events.ts')
const { createAdaRequest } = await import('../lib/support.ts')
const { UserError } = await import('../lib/platform.ts')
test.after(() => rmSync(dir, { recursive: true, force: true }))

const run = (sql: string, ...a: (string | number | null)[]) => Number(db.prepare(sql).run(...a).lastInsertRowid)
const get = <T>(sql: string, ...a: (string | number)[]) => db.prepare(sql).get(...a) as T
const all = <T>(sql: string, ...a: (string | number)[]) => db.prepare(sql).all(...a) as T[]
const day = 864e5

// ---------- ICS ----------
test('ICS: UTC times, stamp, uid, escaped text, folded lines, CRLF', () => {
  assert.equal(icsDate('2026-10-08T20:00:00.000Z'), '20261008T200000Z')
  assert.equal(icsEscape('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne')
  const ics = buildIcs(
    { id: 7, title: 'Rock, Paper; Scissors', starts_at: '2026-10-08T00:30:00.000Z', status: 'published', description: 'Line one\nLine two ' + 'x'.repeat(200), venue: 'The Hall', address: '1 Main St', city: 'Austin', state: 'TX' },
    'http://localhost:3000/events/rps',
    new Date('2026-01-02T03:04:05Z'),
  )
  assert.ok(ics.endsWith('\r\n') && !/[^\r]\n/.test(ics), 'CRLF line endings only')
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'))
  for (const want of ['UID:event-7@ticketstorm', 'DTSTAMP:20260102T030405Z', 'DTSTART:20261008T003000Z', 'DTEND:20261008T033000Z', 'SUMMARY:Rock\\, Paper\\; Scissors', 'STATUS:CONFIRMED']) {
    assert.ok(ics.includes(want), want)
  }
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `line too long: ${line.length}`)
  // unfolding gives the original text back
  assert.ok(ics.replace(/\r\n /g, '').includes('DESCRIPTION:Line one\\nLine two ' + 'x'.repeat(200)))
  assert.ok(buildIcs({ id: 1, title: 't', starts_at: '2026-10-08T00:30:00Z', status: 'cancelled', description: null, venue: 'v', address: 'a', city: 'c', state: 's' }, 'u').includes('STATUS:CANCELLED'))
})

test('ICS folding counts octets, not characters', () => {
  const folded = fold('SUMMARY:' + 'é'.repeat(80))
  for (const l of folded.split('\r\n')) assert.ok(Buffer.byteLength(l) <= 75)
  assert.equal(folded.replace(/\r\n /g, ''), 'SUMMARY:' + 'é'.repeat(80))
})

// ---------- fixtures ----------
const org = run("INSERT INTO orgs (name, status) VALUES ('T','approved')")
const near = run("INSERT INTO cities (name, state, lat, lng, tax_rate_bps) VALUES ('Near','NN',40,-74,1000)")
const far = run("INSERT INTO cities (name, state, lat, lng, tax_rate_bps) VALUES ('Far','FF',34,-118,0)")
const venueNear = run("INSERT INTO venues (org_id, slug, name, address, city_id, lat, lng, tz) VALUES (?, 'near-hall','Near Hall','a',?,40,-74,'UTC')", org, near)
const venueFar = run("INSERT INTO venues (org_id, slug, name, address, city_id, lat, lng, tz) VALUES (?, 'far-hall','Far Hall','a',?,34,-118,'UTC')", org, far)
// 12 seats in row A: 1 accessible + 2 companion, 4 accessible + 5 companion (the generator's layout)
const sec = run("INSERT INTO sections (venue_id, name, kind, path, label_x, label_y, rank) VALUES (?, 'S', 'reserved', '', 0, 0, 3)", venueNear)
for (let n = 1; n <= 12; n++) run('INSERT INTO seats (section_id, row, number, x, y, accessible, companion) VALUES (?, ?, ?, 0, 0, ?, ?)', sec, 'A', n, n === 1 || n === 4 ? 1 : 0, n === 2 || n === 5 ? 1 : 0)
const artist = run("INSERT INTO artists (slug, name, genres) VALUES ('band','Band','[\"Rock\"]')")
const user = (name: string, extra = '') => run(`INSERT INTO users (email, name, phone, password_hash${extra ? ', ' + extra.split('=')[0] : ''}) VALUES (?,?,?,'x'${extra ? ', ' + extra.split('=')[1] : ''})`, `${name}@x.test`, name, '+15550100')
function makeEvent(slug: string, cents: number, venue = venueNear, status = 'published', extra: { series?: string; fee?: string } = {}) {
  const ev = run(`INSERT INTO events (org_id, venue_id, series_key, slug, title, category, genre, starts_at, status, onsale_at, ticket_limit, fee_rule) VALUES (?,?,?,?,?, 'music', 'Rock', ?, ?, ?, 3, ?)`, org, venue, extra.series ?? null, slug, slug, new Date(Date.now() + 40 * day).toISOString(), status, new Date(Date.now() - day).toISOString(), extra.fee ?? null)
  run("INSERT INTO price_levels (event_id, name, price_cents, ticket_type) VALUES (?, 'Only', ?, 'standard')", ev, cents)
  inv.generateInventory(ev)
  return ev
}
const owner = (s: string, userId: number | null = null) => ({ sessionToken: s, userId })
const seat = (ev: number, n: number) => get<{ id: number }>('SELECT i.id FROM inventory i JOIN seats st ON st.id = i.seat_id WHERE i.event_id = ? AND st.number = ?', ev, n).id

// ---------- unsubscribe tokens ----------
test('unsubscribe token: verifies, rejects tampering, and turns one email category off', () => {
  const u = user('unsub')
  const t = unsubToken(u, 'alerts')
  assert.deepEqual(verifyUnsub(t), { userId: u, category: 'alerts' })
  const [id, cat, sig] = t.split('.')
  assert.equal(verifyUnsub(`${Number(id) + 1}.${cat}.${sig}`), undefined, 'other user')
  assert.equal(verifyUnsub(`${id}.marketing.${sig}`), undefined, 'other category')
  assert.equal(verifyUnsub(`${id}.${cat}.${sig.replace(/.$/, sig.endsWith('0') ? '1' : '0')}`), undefined, 'flipped signature')
  assert.equal(verifyUnsub(`${id}.nonsense.${sig}`), undefined)
  assert.equal(verifyUnsub(''), undefined)
  assert.equal(verifyUnsub('garbage'), undefined)
  assert.equal(prefsOf(get<{ notif_prefs: string | null }>('SELECT notif_prefs FROM users WHERE id = ?', u).notif_prefs).alerts_email, true)
  unsubscribe(u, 'alerts')
  const p = prefsOf(get<{ notif_prefs: string | null }>('SELECT notif_prefs FROM users WHERE id = ?', u).notif_prefs)
  assert.equal(p.alerts_email, false)
  assert.equal(p.marketing_email, undefined, 'other categories untouched')
  assert.equal(p.alerts_inapp, true)
})

test('optional email carries an unsubscribe link and honours the preference; essential order mail is not a preference', () => {
  const u = user('mail')
  const before = all('SELECT * FROM outbox').length
  assert.equal(emailUser(u, 'alerts', 'mail@x.test', 'Hi', 'Body'), true)
  const m = get<{ body: string }>('SELECT body FROM outbox ORDER BY id DESC')
  assert.match(m.body, /\/unsubscribe\?t=\d+\.alerts\.[0-9a-f]{64}/)
  unsubscribe(u, 'alerts')
  assert.equal(emailUser(u, 'alerts', 'mail@x.test', 'Hi', 'Body'), false)
  assert.equal(all('SELECT * FROM outbox').length, before + 1)
  assert.equal(verifyUnsub(unsubToken(u, 'orders')), undefined, 'orders is not an unsubscribable category')
  // essential: an order alert still reaches the inbox with everything off, and its mail has no footer
  db.prepare('UPDATE users SET notif_prefs = ? WHERE id = ?').run(JSON.stringify({ alerts_email: false, alerts_inapp: false, alerts_sms: false }), u)
  assert.equal(alertUser(u, 'orders', 'ticket_delivered', 'order:1', { title: 'Essential', link: '/x' }), true)
  assert.equal(all("SELECT * FROM notifications WHERE user_id = ? AND title = 'Essential'", u).length, 1)
  assert.doesNotMatch(get<{ body: string }>("SELECT body FROM outbox WHERE subject = 'Essential'").body, /unsubscribe/)
})

// ---------- alerts ----------
test('new show by a followed artist: one inbox + one email, however often the jobs run; unsubscribed -> inbox only', () => {
  const fan = user('fan')
  const fan2 = user('fan2')
  toggleFavorite(fan, 'artist', artist)
  toggleFavorite(fan2, 'artist', artist)
  unsubscribe(fan2, 'alerts')
  // organizer drafts a show with the artist headlining, then publishes it
  const draft = createEvent(org, { title: 'Band Live', category: 'music', genre: 'Rock', venueId: venueNear, startsAt: new Date(Date.now() + 30 * day).toISOString(), doorsAt: null, image: '', description: '' }, artist)
  run("INSERT INTO price_levels (event_id, name, price_cents, ticket_type) VALUES (?, 'Only', 4000, 'standard')", draft)
  runJobs()
  assert.equal(all('SELECT * FROM notifications WHERE user_id = ?', fan).length, 0, 'drafts are not announced')
  publishEvent(draft)
  const sent = () => ({
    inbox: all<{ title: string }>("SELECT title FROM notifications WHERE kind = 'new_event' AND user_id = ?", fan),
    mail: all<{ to: string }>("SELECT \"to\" FROM outbox WHERE subject LIKE 'New show: Band Live' AND \"to\" = 'fan@x.test'"),
  })
  runJobs()
  runJobs()
  runAlerts()
  assert.equal(sent().inbox.length, 1, 'inbox: exactly one')
  assert.equal(sent().mail.length, 1, 'email: exactly one')
  assert.match(get<{ body: string }>("SELECT body FROM outbox WHERE subject = 'New show: Band Live' AND \"to\" = 'fan@x.test'").body, /unsubscribe\?t=/)
  assert.equal(all("SELECT * FROM alerts_sent WHERE kind = 'new_event' AND user_id = ?", fan).length, 1)
  // fan2 unsubscribed from alert emails earlier: still in the inbox, no email
  assert.equal(all("SELECT * FROM notifications WHERE kind = 'new_event' AND user_id = ?", fan2).length, 1)
  assert.equal(all("SELECT * FROM outbox WHERE \"to\" = 'fan2@x.test' AND subject LIKE 'New show%'").length, 0)
})

test('SMS goes out only when the category has SMS turned on', () => {
  const u = user('sms')
  assert.equal(alertUser(u, 'alerts', 'x_kind', 'r1', { title: 'T1', link: '/' }), true)
  assert.equal(all("SELECT * FROM outbox WHERE channel = 'sms' AND \"to\" = '+15550100' AND body LIKE '%T1%'").length, 0)
  db.prepare('UPDATE users SET notif_prefs = ? WHERE id = ?').run(JSON.stringify({ alerts_sms: true, alerts_inapp: false }), u)
  assert.equal(alertUser(u, 'alerts', 'x_kind', 'r2', { title: 'T2', link: '/' }), true)
  assert.equal(all("SELECT * FROM outbox WHERE channel = 'sms' AND body LIKE '%T2%'").length, 1)
  assert.equal(all("SELECT * FROM notifications WHERE user_id = ? AND title = 'T2'", u).length, 0, 'inbox turned off')
  assert.equal(alertUser(u, 'alerts', 'x_kind', 'r2', { title: 'T2', link: '/' }), false, 'same (kind, ref) never twice')
})

test('followed venue: only events inside the fan\'s radius; no home city means no filter', () => {
  const homeNear = user('homenear')
  const nohome = user('nohome')
  for (const u of [homeNear, nohome]) {
    toggleFavorite(u, 'venue', venueFar)
    toggleFavorite(u, 'venue', venueNear)
  }
  saveAlertArea(homeNear, String(near), '50')
  assert.throws(() => saveAlertArea(homeNear, String(near), '0'), UserError)
  const ev = makeEvent('far-show', 5000, venueFar)
  db.prepare('UPDATE events SET published_at = ? WHERE id = ?').run(new Date(Date.now() + 1000).toISOString(), ev)
  const near2 = makeEvent('near-show', 5000, venueNear)
  db.prepare('UPDATE events SET published_at = ? WHERE id = ?').run(new Date(Date.now() + 1000).toISOString(), near2)
  runAlerts()
  const titles = (u: number) => all<{ title: string }>("SELECT title FROM notifications WHERE kind = 'new_event' AND user_id = ? ORDER BY title", u).map((r) => r.title)
  assert.deepEqual(titles(homeNear), ['New show: near-show'])
  assert.deepEqual(titles(nohome), ['New show: far-show', 'New show: near-show'])
})

test('on-sale reminder (1h) and price drop are sent once each', () => {
  const fan = user('watcher')
  const ev = makeEvent('watched', 6000)
  db.prepare('UPDATE events SET onsale_at = ? WHERE id = ?').run(new Date(Date.now() + 30 * 60_000).toISOString(), ev)
  toggleFavorite(fan, 'event', ev)
  assert.equal(get<{ last_price: number }>("SELECT last_price FROM favorites WHERE user_id = ? AND kind = 'event'", fan).last_price, 6000)
  runAlerts()
  runAlerts()
  assert.equal(all("SELECT * FROM notifications WHERE user_id = ? AND kind = 'onsale_soon'", fan).length, 1)
  assert.equal(all("SELECT * FROM notifications WHERE user_id = ? AND kind = 'price_drop'", fan).length, 0, 'same price: nothing')
  db.prepare('UPDATE price_levels SET price_cents = 4500 WHERE event_id = ?').run(ev)
  runAlerts()
  runAlerts()
  const drops = all<{ body: string }>("SELECT body FROM notifications WHERE user_id = ? AND kind = 'price_drop'", fan)
  assert.equal(drops.length, 1)
  assert.match(drops[0].body, /\$45\.00, down from \$60\.00/)
  assert.equal(all("SELECT * FROM outbox WHERE \"to\" = 'watcher@x.test' AND subject LIKE 'Price drop%'").length, 1)
  db.prepare('UPDATE price_levels SET price_cents = 4000 WHERE event_id = ?').run(ev)
  runAlerts()
  assert.equal(all("SELECT * FROM notifications WHERE user_id = ? AND kind = 'price_drop'", fan).length, 2, 'a further drop is a new alert')
  db.prepare('UPDATE price_levels SET price_cents = 4500 WHERE event_id = ?').run(ev) // up
  runAlerts()
  db.prepare('UPDATE price_levels SET price_cents = 4000 WHERE event_id = ?').run(ev) // back down to a price already notified
  runAlerts()
  assert.equal(all("SELECT * FROM notifications WHERE user_id = ? AND kind = 'price_drop'", fan).length, 2, '(user, kind, ref) is unique, so the same price is never announced twice')
})

// ---------- companion seats ----------
test('an accessible seat holds its companion in the same transaction; opt-out, limits, orphan rule and availability are respected', () => {
  const ev = makeEvent('ada', 5000)
  const acc = seat(ev, 1)
  const comp = seat(ev, 2)
  // opt out: seat 4 alone (its companion 5 stays free)
  const solo = inv.holdSeats(ev, owner('c2'), [seat(ev, 4)], false)
  assert.deepEqual(solo.ids, [seat(ev, 4)])
  inv.releaseHold(solo.holdId, 'c2')
  const h = inv.holdSeats(ev, owner('c1'), [acc])
  assert.deepEqual([...h.ids].sort(), [acc, comp].sort(), 'both seats held')
  assert.equal(all("SELECT id FROM inventory WHERE hold_id = ? AND status = 'held'", h.holdId).length, 2)
  // companion taken by someone else: clear refusal, nothing held
  inv.holdSeats(ev, owner('c3'), [seat(ev, 5), seat(ev, 6)], false)
  assert.throws(() => inv.holdSeats(ev, owner('c4'), [seat(ev, 4)]), /companion seat \(Section S Row A Seat 5\) is not available/)
  assert.equal(all("SELECT id FROM inventory WHERE hold_id IN (SELECT id FROM holds WHERE session_token = 'c4')").length, 0)
  // limit: ticket_limit 2 -> accessible + companion fits exactly
  db.prepare('UPDATE events SET ticket_limit = 2 WHERE id = ?').run(ev)
  inv.releaseHold(h.holdId, 'c1')
  const ok = inv.holdSeats(ev, owner('c6'), [acc]) // exactly 2 = the limit
  assert.equal(ok.ids.length, 2)
  inv.releaseHold(ok.holdId, 'c6')
  db.prepare('UPDATE events SET ticket_limit = 3 WHERE id = ?').run(ev)
  assert.throws(() => inv.holdSeats(ev, owner('c7'), [acc, seat(ev, 9), seat(ev, 10)]), /no room under your ticket limit for the companion/)
  assert.equal(inv.holdSeats(ev, owner('c7'), [acc, seat(ev, 9), seat(ev, 10)], false).ids.length, 3, 'without the companion it fits')
})

// ---------- search ----------
test('search: price range and sort follow the all-in toggle; genre/venue/accessible/resale filters validate', () => {
  const cheap = makeEvent('s-cheap', 3000, venueNear, 'published', { fee: JSON.stringify({ service_pct: 10, facility_cents: 300, order_cents: 0 }) })
  const dear = makeEvent('s-dear', 9000, venueFar, 'published', { fee: JSON.stringify({ service_pct: 10, facility_cents: 300, order_cents: 0 }) })
  const slugs = (q: string, allIn = false) => searchEvents(parseFilters(Object.fromEntries(new URLSearchParams(q))), 100, { allIn }).rows.map((r) => r.slug).filter((s) => s.startsWith('s-'))
  assert.deepEqual(slugs('min=0&max=100'), ['s-cheap', 's-dear'])
  assert.deepEqual(slugs('min=50'), ['s-dear'])
  assert.deepEqual(slugs('max=40'), ['s-cheap'])
  // $30 face in Near (10% tax): 30 + 3 + 3 = 36 + tax on 36 (10%) = 39.60 all-in, so max=35 keeps it on face value but not all-in
  assert.deepEqual(slugs('max=35'), ['s-cheap'])
  assert.deepEqual(slugs('max=35', true), [])
  assert.deepEqual(slugs('max=40', true), ['s-cheap'])
  assert.deepEqual(slugs('sort=price'), ['s-cheap', 's-dear'])
  assert.equal(parseFilters({ min: '-5', max: 'abc', venue: 'Bad Slug!', sort: 'nonsense' }).min, undefined)
  assert.equal(parseFilters({ venue: 'Bad Slug!' }).venue, undefined)
  assert.equal(parseFilters({ sort: 'nonsense' }).sort, undefined)
  assert.deepEqual(slugs('venue=far-hall'), ['s-dear'])
  assert.deepEqual(slugs('genre=Rock&venue=near-hall&max=40'), ['s-cheap'])
  assert.deepEqual(slugs('genre=Jazz'), [])
  // accessible = the EVENT still has an accessible seat to buy: sell them all and it drops out (the far venue has none to begin with)
  assert.deepEqual(slugs('accessible=1'), ['s-cheap'])
  db.prepare("UPDATE inventory SET status = 'sold' WHERE event_id = ? AND seat_id IN (SELECT id FROM seats WHERE accessible = 1)").run(cheap)
  assert.deepEqual(slugs('accessible=1'), [])
  assert.deepEqual(slugs('presale=1'), [])
  run("INSERT INTO onsale_windows (event_id, name, kind, starts_at, ends_at) VALUES (?, 'P', 'fanclub', ?, ?)", dear, new Date().toISOString(), new Date(Date.now() + day).toISOString())
  assert.deepEqual(slugs('presale=1'), ['s-dear'])
  assert.deepEqual(slugs('resale=1'), [])
})

test('search: distance and popularity sorts; Showing N of M total counts every match', () => {
  const ref = near
  const r = searchEvents(parseFilters({ sort: 'distance' }), 100, { ref })
  const dist = r.rows.map((x) => x.venue)
  assert.equal(dist[0], 'Near Hall')
  assert.equal(dist[dist.length - 1], 'Far Hall')
  const limited = searchEvents(parseFilters({}), 2)
  assert.equal(limited.rows.length, 2)
  assert.ok(limited.total > 2)
})

// ---------- recommendations ----------
test('recommendation score: genre overlap, followed artist, distance decay, popularity', () => {
  const home = { lat: 40, lng: -74 }
  const base = { genre: 'Rock', popularity: 0, artistIds: [] as number[], vlat: 40, vlng: -74 }
  const p = { genres: new Map([['Rock', 1]]), artists: new Set([9]), home }
  assert.equal(score(base, p), 2 + 4) // overlap 2 + no distance
  assert.equal(score({ ...base, artistIds: [9] }, p), 2 + 6 + 4)
  assert.equal(score({ ...base, genre: 'Jazz' }, p), 4)
  assert.ok(score({ ...base, vlat: 34, vlng: -118 }, p) < 0.1 + 2, 'far away decays to ~0')
  assert.equal(score({ ...base, popularity: 100 }, p), 2 + 4 + 3)
  assert.equal(score(base, { genres: new Map([['Rock', 50]]), artists: new Set(), home }), 6 + 4, 'overlap counts up to 3 times')
})

test('recommended rail: followed artist\'s shows rank first; guests get a popularity/distance fallback', () => {
  const fan = user('recs')
  const other = run("INSERT INTO artists (slug, name, genres) VALUES ('other','Other','[\"Polka\"]')")
  const mine = run("INSERT INTO artists (slug, name, genres) VALUES ('mine','Mine','[\"Folk\"]')")
  const a = makeEvent('rec-followed', 5000)
  const b = makeEvent('rec-other', 5000)
  db.prepare('INSERT INTO event_artists (event_id, artist_id) VALUES (?, ?)').run(a, mine)
  db.prepare('INSERT INTO event_artists (event_id, artist_id) VALUES (?, ?)').run(b, other)
  db.prepare("UPDATE events SET genre = 'Polka', popularity = 100 WHERE id = ?").run(b)
  db.prepare("UPDATE events SET genre = 'Folk', popularity = 0 WHERE id = ?").run(a)
  toggleFavorite(fan, 'artist', mine)
  assert.equal(recommendedEvents(fan, near, 1)[0].slug, 'rec-followed')
  assert.equal(recommendedEvents(null, near, 1)[0].popularity, 100, 'guest: popularity decides')
})

// ---------- ADA request ----------
test('ADA request creates a support ticket and validates input', () => {
  const id = createAdaRequest(null, { email: 'Guest@X.test', name: 'G', need: 'Wheelchair space', details: 'Two guests, one wheelchair', event: 'ada' })
  const t = get<{ email: string; kind: string; subject: string; status: string; messages: string }>('SELECT * FROM support_tickets WHERE id = ?', id)
  assert.equal(t.email, 'guest@x.test')
  assert.equal(t.kind, 'ada')
  assert.equal(t.status, 'open')
  assert.match(t.subject, /^ADA request: Wheelchair space for ada$/)
  assert.match(JSON.parse(t.messages)[0].text, /Two guests/)
  assert.throws(() => createAdaRequest(null, { email: 'nope', name: '', need: 'Wheelchair space', details: 'x' }), UserError)
  assert.throws(() => createAdaRequest(null, { email: 'a@b.co', name: '', need: 'Teleport', details: 'x' }), UserError)
  assert.throws(() => createAdaRequest(null, { email: 'a@b.co', name: '', need: 'Other', details: '' }), UserError)
})

test('organizer event details: validated, other info keys kept', () => {
  const { setEventInfo } = organizerLib
  const ev = makeEvent('info-ev', 5000)
  db.prepare("UPDATE events SET info = ? WHERE id = ?").run(JSON.stringify({ keep: 1 }), ev)
  setEventInfo(ev, { age: '18+', bag: 'No bags', notices: '<b>Gate C</b> closed', setTimes: '19:30 Opener\n20:45 Headliner' })
  const info = JSON.parse(get<{ info: string }>('SELECT info FROM events WHERE id = ?', ev).info)
  assert.deepEqual(info.set_times, [{ act: 'Opener', time: '19:30' }, { act: 'Headliner', time: '20:45' }])
  assert.equal(info.keep, 1)
  assert.equal(info.notices, '<b>Gate C</b> closed', 'stored as text; React escapes it when rendered')
  assert.throws(() => setEventInfo(ev, { age: '', bag: '', notices: '', setTimes: '25:00 Late' }), UserError)
  assert.throws(() => setEventInfo(ev, { age: '', bag: '', notices: 'x'.repeat(501), setTimes: '' }), UserError)
})
