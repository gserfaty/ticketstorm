// Deterministic seed. `npm run reset` deletes the DB first, then runs this.
import { db, tx } from '../lib/db.ts'
import { hashPassword } from '../lib/auth.ts'
import { generateVenue, venueCapacity } from '../lib/venue-gen.ts'
import { generateInventory, holdBestAvailable } from '../lib/inventory.ts'
import { addWindow, assignWindow } from '../lib/access.ts'
import { joinQueue } from '../lib/queue.ts'
import { finalize } from '../lib/orders.ts'
import { createListing } from '../lib/resale.ts'
import { localToUtc, slugify } from '../lib/format.ts'
import type { VenueKind } from '../lib/venue-gen.ts'

process.env.FRAUD_RANDOM_PCT = '0' // the seed's own orders must not land in review by chance; scripted review cases are below

if (db.prepare('SELECT count(*) AS n FROM users').get()!.n) {
  console.log('Already seeded. Run `npm run reset` to start over.')
  process.exit(0)
}

function mulberry32(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rnd = mulberry32(20260101)
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1))
const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]
const json = (o: unknown) => JSON.stringify(o)

const cities: [string, string, number, number, number, string][] = [
  ['New York', 'NY', 40.7128, -74.006, 888, 'America/New_York'],
  ['Los Angeles', 'CA', 34.0522, -118.2437, 950, 'America/Los_Angeles'],
  ['Chicago', 'IL', 41.8781, -87.6298, 1025, 'America/Chicago'],
  ['Houston', 'TX', 29.7604, -95.3698, 825, 'America/Chicago'],
  ['Phoenix', 'AZ', 33.4484, -112.074, 860, 'America/Phoenix'],
  ['Philadelphia', 'PA', 39.9526, -75.1652, 800, 'America/New_York'],
  ['Seattle', 'WA', 47.6062, -122.3321, 1025, 'America/Los_Angeles'],
  ['Denver', 'CO', 39.7392, -104.9903, 880, 'America/Denver'],
  ['Atlanta', 'GA', 33.749, -84.388, 890, 'America/New_York'],
  ['Miami', 'FL', 25.7617, -80.1918, 700, 'America/New_York'],
  ['Nashville', 'TN', 36.1627, -86.7816, 925, 'America/Chicago'],
  ['Boston', 'MA', 42.3601, -71.0589, 625, 'America/New_York'],
]

// name, venue kind, city index
// optional 4th: latitude offset in degrees (0.72 deg ~ 50 mi) for a second venue in the same metro
const venues: [string, VenueKind, number, number?][] = [
  ['Empire Arena', 'arena', 0],
  ['Pacific Stadium', 'stadium', 1],
  ['Lakefront Theatre', 'theater', 2],
  ['Rimrock Amphitheater', 'amphitheater', 7],
  ['The Basement', 'club', 10],
  ['Peachtree Arena', 'arena', 8],
  ['Emerald Hall', 'theater', 6],
  ['Bayfront Amphitheater', 'amphitheater', 9],
  ['Catskill Pavilion', 'amphitheater', 0, 0.72],
]
const venueKinds = venues.map((v) => v[1])

// name, category, genre
const artists: [string, string, string][] = [
  ['Neon Harbor', 'music', 'Pop'], ['The Velvet Static', 'music', 'Rock'], ['Marlowe Quinn', 'music', 'Country'],
  ['DJ Parallax', 'music', 'Electronic'], ['Sable & Stone', 'music', 'Indie'], ['Cora Valdez', 'music', 'Latin'],
  ['Iron Orchard', 'music', 'Metal'], ['Lena Okafor', 'music', 'R&B'], ['Midnight Pelicans', 'music', 'Indie'],
  ['Rook Atlas', 'music', 'Hip-Hop'], ['Juniper Vale', 'music', 'Folk'], ['The Brass Wolves', 'music', 'Jazz'],
  ['Hollow Crown', 'music', 'Rock'], ['Kiko Tanaka', 'music', 'Pop'], ['Dusty Mirage', 'music', 'Country'],
  ['Metro Thunder', 'sports', 'Basketball'], ['Harbor Kings', 'sports', 'Hockey'], ['Lakeside Lynx', 'sports', 'Basketball'],
  ['Capital FC', 'sports', 'Soccer'], ['Summit Rovers', 'sports', 'Soccer'],
  ['Dana Whitfield', 'comedy', 'Stand-up'], ['Theo Brandt', 'comedy', 'Stand-up'], ['Priya Nair', 'comedy', 'Improv'],
  ['The Lantern Players', 'arts-theater', 'Theater'], ['Orchestra Meridian', 'arts-theater', 'Classical'], ['Aurora Ballet', 'arts-theater', 'Dance'],
  ['Captain Comet Live', 'family', 'Kids'], ['Circus Aurelia', 'family', 'Circus'],
  ['Sunstorm Festival', 'festivals', 'Multi-genre'], ['Riverbend Jazz & Blues', 'festivals', 'Jazz'],
]

// which venue kinds suit which category
const fits: Record<string, VenueKind[]> = {
  music: ['arena', 'stadium', 'theater', 'amphitheater', 'club'],
  sports: ['arena', 'stadium'],
  comedy: ['theater', 'club'],
  'arts-theater': ['theater'],
  family: ['arena', 'theater'],
  festivals: ['amphitheater', 'stadium'],
}

const users: [string, string, string][] = [
  ['fan@ticketstorm.test', 'Frankie Fan', 'fan'],
  ['fan2@ticketstorm.test', 'Fiona Fan', 'fan'],
  ['organizer@ticketstorm.test', 'Olive Organizer', 'fan'],
  ['scanner@ticketstorm.test', 'Sam Scanner', 'fan'],
  ['admin@ticketstorm.test', 'Ada Admin', 'admin'],
]

tx(() => {
  const now = new Date()
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const DAY = 86_400_000

  const cityIds = cities.map(([name, state, lat, lng, tax]) =>
    Number(db.prepare('INSERT INTO cities (name, state, lat, lng, tax_rate_bps) VALUES (?,?,?,?,?)').run(name, state, lat, lng, tax).lastInsertRowid))

  const uid: Record<string, number> = {}
  for (const [email, name, role] of users) {
    uid[email] = Number(
      db.prepare('INSERT INTO users (email, name, password_hash, role, email_verified_at) VALUES (?,?,?,?,?)')
        .run(email, name, hashPassword('password123'), role, now.toISOString()).lastInsertRowid)
  }

  users.forEach(([email], i) => db.prepare('UPDATE users SET phone = ? WHERE email = ?').run(`+1555010${i}00`, email))

  const orgId = Number(db.prepare("INSERT INTO orgs (name, status) VALUES ('Storm Live','approved')").run().lastInsertRowid)
  const member = db.prepare('INSERT INTO org_members (org_id, user_id, role) VALUES (?,?,?)')
  member.run(orgId, uid['organizer@ticketstorm.test'], 'owner')
  member.run(orgId, uid['scanner@ticketstorm.test'], 'scanner')

  db.prepare("INSERT INTO feature_flags (key, enabled) VALUES ('require_event_approval', 0)").run()

  const venueRows = venues.map(([name, kind, ci, dLat = 0], i) => {
    const [, , lat, lng, , tz] = cities[ci]
    const secs = generateVenue(kind)
    const info = json({
      parking: 'On-site lots open 3 hours before doors. Prepaid parking recommended.',
      transit: 'Short walk from the nearest metro/bus stop. Rideshare drop-off at Gate A.',
      bag: 'Bags no larger than 12x6x12 in. Clear bags preferred.',
      accessibility: 'Accessible seating and companion seats in every reserved section. Elevators at all entrances.',
      faq: [{ q: 'What time do doors open?', a: 'One hour before showtime unless noted.' }],
    })
    const venueId = Number(
      db.prepare('INSERT INTO venues (org_id, slug, name, address, city_id, lat, lng, tz, capacity, info) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(orgId, slugify(name), name, `${100 + i * 17} Main St`, cityIds[ci], lat + dLat + (rnd() - 0.5) * 0.04, lng + (rnd() - 0.5) * 0.04, tz, venueCapacity(secs), info)
        .lastInsertRowid)
    const insSection = db.prepare('INSERT INTO sections (venue_id, name, kind, capacity, path, label_x, label_y, rank) VALUES (?,?,?,?,?,?,?,?)')
    const insSeat = db.prepare('INSERT INTO seats (section_id, row, number, x, y, accessible, companion, obstructed) VALUES (?,?,?,?,?,?,?,?)')
    for (const s of secs) {
      const sid = Number(insSection.run(venueId, s.name, s.kind, s.capacity, s.path, s.label_x, s.label_y, s.rank).lastInsertRowid)
      for (const t of s.seats) insSeat.run(sid, t.row, t.number, t.x, t.y, t.accessible, t.companion, t.obstructed)
    }
    return { id: venueId, tz, kind }
  })

  const artistRows = artists.map(([name, category, genre]) => ({
    id: Number(
      db.prepare('INSERT INTO artists (slug, name, bio, genres, links) VALUES (?,?,?,?,?)')
        .run(slugify(name), name, `${name} is a ${genre.toLowerCase()} act known for unforgettable live shows.`, json([genre]), json({})).lastInsertRowid),
    name, category, genre, slug: slugify(name),
  }))
  const relate = db.prepare('INSERT OR IGNORE INTO artist_related (artist_id, related_id) VALUES (?,?)')
  for (const a of artistRows) {
    const same = artistRows.filter((b) => b.category === a.category && b.id !== a.id)
    for (let i = 0; i < 2 && same.length; i++) relate.run(a.id, pick(same).id)
  }

  const insEvent = db.prepare(
    `INSERT INTO events (org_id, venue_id, series_key, slug, title, category, genre, starts_at, doors_at, description, info, status, onsale_at, popularity)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const insLevel = db.prepare('INSERT INTO price_levels (event_id, name, color, price_cents, ticket_type) VALUES (?,?,?,?,?)')
  // Levels match generateInventory: Standing only where the venue has GA areas, Accessible only where it has reserved seats.
  const addLevels = (eventId: number, base: number, kind: VenueKind) => {
    if (kind !== 'club') {
      insLevel.run(eventId, 'General', '#3b82f6', base * 100, 'standard')
      insLevel.run(eventId, 'Premium', '#a855f7', base * 200, 'standard')
      insLevel.run(eventId, 'VIP', '#ec4899', base * 400, 'vip')
      insLevel.run(eventId, 'Accessible', '#14b8a6', base * 100, 'accessible')
    }
    if (kind !== 'theater') insLevel.run(eventId, 'Standing', '#22c55e', base * 100, 'standing')
  }
  const insBill = db.prepare('INSERT INTO event_artists (event_id, artist_id, billing) VALUES (?,?,?)')
  
  // 80 upcoming (days 3..120) + 3 past
  const offsets = [...Array.from({ length: 80 }, () => int(3, 120)), -12, -30, -55]
  offsets.forEach((off, i) => {
    const a = pick(artistRows)
    const vs = venueRows.filter((v) => fits[a.category].includes(v.kind))
    const v = pick(vs)
    const d = new Date(today + off * DAY)
    const [y, m, day] = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]
    const startsAt = localToUtc(y, m, day, a.category === 'sports' ? 19 : 20, 0, v.tz)
    const doorsAt = new Date(Date.parse(startsAt) - 3_600_000).toISOString()
    const opp = pick(artistRows.filter((b) => b.category === 'sports' && b.id !== a.id))
    const title = a.category === 'sports'
      ? `${a.name} vs ${opp.name}`
      : pick([`${a.name} Live`, `${a.name}: The Storm Tour`, `An Evening with ${a.name}`])
    const slug = `${slugify(title)}-${i}`

    let status = 'published'
    if (off > 0 && i === 5) status = 'cancelled'
    if (off > 0 && i === 11) status = 'postponed'
    if (off > 0 && i === 17) status = 'rescheduled'
    // ~10% not yet on sale; the rest went on sale 5..40 days ago
    const onsale = off < 0 ? today - 60 * DAY : i % 10 === 3 ? today + int(2, 20) * DAY : today - int(5, 40) * DAY
    const id = Number(
      insEvent.run(orgId, v.id, a.slug, slug, title, a.category, a.genre, startsAt, doorsAt,
        `${title}. One night only.`, json({ age: 'All ages', bag: 'Clear bags only', notices: '', set_times: [] }),
        status, new Date(onsale).toISOString(), int(0, 100)).lastInsertRowid)
    insBill.run(id, a.id, 0)
    addLevels(id, a.category === 'sports' ? int(40, 90) : int(25, 70), v.kind)
    if (a.category === 'music' && rnd() < 0.3) insBill.run(id, pick(artistRows.filter((b) => b.category === 'music' && b.id !== a.id)).id, 1)
  })

  // Fixed events so discovery checks are verifiable: same artist, two venues ~50 mi apart,
  // a Saturday and a Wednesday, one cancelled, one not yet on sale.
  const fixedArtist = artistRows[0]
  const dayAhead = (dow: number) => today + (((dow - new Date(today).getUTCDay() + 7) % 7) || 7) * DAY
  const fixed: [string, number, number, string, number][] = [
    // slug, venue index, day (ms), status, onsale offset days
    ['neon-harbor-empire-saturday', 0, dayAhead(6), 'published', -10],
    ['neon-harbor-catskill-saturday', 8, dayAhead(6), 'published', -10],
    ['neon-harbor-empire-wednesday', 0, dayAhead(3), 'published', -10],
    ['neon-harbor-empire-cancelled', 0, dayAhead(5), 'cancelled', -10],
    ['neon-harbor-empire-onsale-soon', 0, dayAhead(5) + 7 * DAY, 'published', 3],
    // P9: moved to a new date; every ticket holder can ask for a refund for the next 7 days
    ['neon-harbor-empire-rescheduled', 0, today + 26 * DAY, 'rescheduled', -10],
  ]
  for (const [slug, vi, day, status, onsaleOff] of fixed) {
    const v = venueRows[vi]
    const d = new Date(day)
    const title = `Neon Harbor Live (${slug.split('-').slice(2).join(' ')})`
    const startsAt = localToUtc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 20, 0, v.tz)
    const id = Number(
      insEvent.run(orgId, v.id, fixedArtist.slug, slug, title, 'music', fixedArtist.genre, startsAt,
        new Date(Date.parse(startsAt) - 3_600_000).toISOString(), `${title}. One night only.`,
        json({ age: 'All ages', bag: 'Clear bags only', notices: '', set_times: [] }), status,
        new Date(today + onsaleOff * DAY).toISOString(), 90).lastInsertRowid)
    insBill.run(id, fixedArtist.id, 0)
    addLevels(id, 50, v.kind)
    if (status === 'rescheduled') db.prepare('UPDATE events SET refund_window_until = ? WHERE id = ?').run(new Date(now.getTime() + 7 * DAY).toISOString(), id)
  }

  // P7. A high-demand show with a waiting room that opens in 2 minutes and admits only 6 a minute.
  const inMin = (m: number) => new Date(now.getTime() + m * 60_000).toISOString()
  {
    const v = venueRows[0]
    const d = new Date(today + 30 * DAY)
    const title = 'Neon Harbor: Megatour Opening Night'
    const startsAt = localToUtc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 20, 0, v.tz)
    const id = Number(
      insEvent.run(orgId, v.id, fixedArtist.slug, 'neon-harbor-megatour', title, 'music', fixedArtist.genre, startsAt,
        new Date(Date.parse(startsAt) - 3_600_000).toISOString(), `${title}. Waiting room on.`,
        json({ age: 'All ages', bag: 'Clear bags only', notices: '', set_times: [] }), 'published', inMin(2), 100).lastInsertRowid)
    insBill.run(id, fixedArtist.id, 0)
    addLevels(id, 80, v.kind)
    db.prepare('UPDATE events SET queue_enabled = 1, queue_rate = 6, queue_cap = 20 WHERE id = ?').run(id)
  }

  // Three-game home stand at Empire Arena with a bundle level: holding a seat in section 202 holds it in all three games.
  const sports = artistRows.filter((a) => a.category === 'sports')
  const series = [20, 27, 34].map((off, i) => {
    const v = venueRows[0]
    const d = new Date(today + off * DAY)
    const title = `${sports[0].name} vs ${sports[i + 1].name} (Home Stand ${i + 1}/3)`
    const startsAt = localToUtc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 19, 0, v.tz)
    const id = Number(
      insEvent.run(orgId, v.id, 'home-stand', `home-stand-${i + 1}`, title, 'sports', sports[0].genre, startsAt,
        new Date(Date.parse(startsAt) - 3_600_000).toISOString(), `${title}. Season bundle available.`,
        json({ age: 'All ages', bag: 'Clear bags only', notices: '', set_times: [] }), 'published',
        new Date(today - 10 * DAY).toISOString(), 80).lastInsertRowid)
    insBill.run(id, sports[0].id, 0)
    addLevels(id, 60, v.kind)
    return id
  })
  db.prepare("INSERT INTO price_levels (event_id, name, color, price_cents, ticket_type, event_ids) VALUES (?,?,?,?,?,?)")
    .run(series[0], 'Season Bundle', '#f97316', 15000, 'standard', json(series))

  for (const e of db.prepare('SELECT id, series_key FROM events').all() as { id: number; series_key: string }[]) {
    generateInventory(e.id, e.id === series[0] ? '202' : null)
  }

})

{
const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString()
// P7 presales: premium seats held back for a code-gated fan club window (open now, code STORMFAN) and for a Verified Fan campaign (registration closes in 10 minutes).
const heldBack = (slug: string, windowId: number) => {
  const ev = db.prepare('SELECT id, venue_id FROM events WHERE slug = ?').get(slug) as { id: number; venue_id: number }
  const top = db.prepare("SELECT min(rank) AS r FROM sections WHERE venue_id = ? AND kind = 'reserved'").get(ev.venue_id) as { r: number }
  for (const sec of db.prepare("SELECT id FROM sections WHERE venue_id = ? AND kind = 'reserved' AND rank = ?").all(ev.venue_id, top.r) as { id: number }[]) assignWindow(ev.id, windowId, sec.id, '')
}
const wed = db.prepare("SELECT id FROM events WHERE slug = 'neon-harbor-empire-wednesday'").get() as { id: number }
const fanclub = addWindow(wed.id, { name: 'Fan Club Presale', kind: 'fanclub', startsAt: inMin(-60), endsAt: inMin(2 * 24 * 60), requiresCode: true, regStarts: null, regEnds: null, slots: 0, buyBy: null })
db.prepare("INSERT INTO access_codes (window_id, code, max_uses) VALUES (?, 'STORMFAN', 25)").run(fanclub)
heldBack('neon-harbor-empire-wednesday', fanclub)
const cat = db.prepare("SELECT id FROM events WHERE slug = 'neon-harbor-catskill-saturday'").get() as { id: number }
const vf = addWindow(cat.id, { name: 'Verified Fan Presale', kind: 'verified_fan', startsAt: inMin(15), endsAt: inMin(3 * 24 * 60), requiresCode: true, regStarts: inMin(-24 * 60), regEnds: inMin(10), slots: 1, buyBy: inMin(2 * 24 * 60) })
heldBack('neon-harbor-catskill-saturday', vf)
}

// P8 pricing: promo codes, offers, a dynamic Platinum level and a Meet & Greet package, add-ons (parking has ONE space).
{
  const org = (db.prepare("SELECT id FROM orgs WHERE name = 'Storm Live'").get() as { id: number }).id
  const ev = (slug: string) => db.prepare('SELECT id, venue_id FROM events WHERE slug = ?').get(slug) as { id: number; venue_id: number }
  const sat = ev('neon-harbor-empire-saturday')
  const mega = ev('neon-harbor-megatour')
  // assign a block of seats (section name, rows) to a new level
  const level = (e: { id: number; venue_id: number }, name: string, color: string, cents: number, type: string, perks: string | null, section: string, rows: string[]) => {
    const id = Number(db.prepare('INSERT INTO price_levels (event_id, name, color, price_cents, ticket_type, perks) VALUES (?,?,?,?,?,?)').run(e.id, name, color, cents, type, perks).lastInsertRowid)
    db.prepare(
      `UPDATE inventory SET price_level_id = ? WHERE event_id = ? AND seat_id IN (SELECT st.id FROM seats st JOIN sections s ON s.id = st.section_id
       WHERE s.venue_id = ? AND s.name = ? AND st.row IN (${rows.map(() => '?').join(',')}) AND st.accessible = 0 AND st.companion = 0)`,
    ).run(id, e.id, e.venue_id, section, ...rows)
    return id
  }
  // Platinum: $250 base, +300% at 100% sold and +50% at a full waiting room, never below $250 or above $900
  const plat = level(sat, 'Platinum', '#eab308', 25000, 'platinum', 'Front rows, centre', '102', ['A', 'B'])
  db.prepare('UPDATE price_levels SET dyn_min_cents = 25000, dyn_max_cents = 90000, dyn_k = 3, dyn_j = 0.5 WHERE id = ?').run(plat)
  level(mega, 'Meet & Greet Package', '#f43f5e', 45000, 'vip', 'Meet the band, early entry, signed poster, commemorative laminate', '101', ['A', 'B'])
  db.prepare('UPDATE events SET order_limit = 4, ticket_limit = 6 WHERE id = ?').run(mega.id)
  for (const [name, pct] of [['child', 50], ['senior', 25], ['student', 20]] as const) {
    db.prepare('INSERT INTO offers (event_id, name, pct_off) SELECT id, ?, ? FROM events').run(name, pct)
  }
  const addon = db.prepare('INSERT INTO addons (event_id, kind, name, price_cents, inventory) VALUES (?,?,?,?,?)')
  addon.run(sat.id, 'parking', 'Lot A parking', 3000, 1)
  addon.run(sat.id, 'merch', 'Tour T-shirt', 3500, 100)
  addon.run(sat.id, 'hospitality', 'Club lounge access', 12000, 20)
  const promo = db.prepare('INSERT INTO promo_codes (org_id, event_id, code, kind, amount, max_uses) VALUES (?,?,?,?,?,?)')
  promo.run(null, null, 'STORM10', 'pct', 10, 1000) // platform-wide
  promo.run(org, sat.id, 'FIVEOFF', 'fixed', 500, 100) // this event only
}

// 30 other fans already waiting for the megatour, so positions are visible (random order: it is still before on-sale).
{
  const ev = db.prepare("SELECT id FROM events WHERE slug = 'neon-harbor-megatour'").get() as { id: number }
  for (let i = 0; i < 30; i++) joinQueue(ev.id, `seed-crowd-${i}`, null)
}

// fan@ gets a paid order (2 seats, upcoming event) through the real checkout path, so /tickets has content.
{
  const fan = db.prepare("SELECT id, email FROM users WHERE email = 'fan@ticketstorm.test'").get() as { id: number; email: string }
  const ev = db.prepare("SELECT id FROM events WHERE slug = 'neon-harbor-empire-saturday'").get() as { id: number }
  const owner = { sessionToken: 'seed-fan-session', userId: fan.id }
  const held = holdBestAvailable(ev.id, owner, 2)
  finalize({
    holdId: held.holdId, sessionToken: owner.sessionToken, userId: fan.id, email: fan.email, key: 'seed-fan-order-1', method: 'card', brand: 'Visa', last4: '4242', exp: '12/39', save: true,
    billing: { name: 'Frankie Fan', address: '1 Main St', city: 'New York', zip: '10001' },
  })
}

// fan2@ buys one seat for the same show and lists it, so the map shows a Verified Resale seat after reset.
{
  const fan2 = db.prepare("SELECT id, email FROM users WHERE email = 'fan2@ticketstorm.test'").get() as { id: number; email: string }
  const ev = db.prepare("SELECT id FROM events WHERE slug = 'neon-harbor-empire-saturday'").get() as { id: number }
  const owner = { sessionToken: 'seed-fan2-session', userId: fan2.id }
  const held = holdBestAvailable(ev.id, owner, 1)
  finalize({
    holdId: held.holdId, sessionToken: owner.sessionToken, userId: fan2.id, email: fan2.email, key: 'seed-fan2-order-1', method: 'card', brand: 'Visa', last4: '4242', exp: '12/39', save: false,
    billing: { name: 'Fiona Fan', address: '2 Main St', city: 'New York', zip: '10001' },
  })
  const t = db.prepare('SELECT id FROM tickets WHERE owner_id = ?').get(fan2.id) as { id: number }
  createListing(fan2.id, t.id, 12500)
}

// P9: a fan order on the rescheduled event (refund button visible until its window closes), and an order the fraud score put in review.
{
  const ev = db.prepare("SELECT id FROM events WHERE slug = 'neon-harbor-empire-rescheduled'").get() as { id: number }
  const user = (email: string) => db.prepare('SELECT id, email FROM users WHERE email = ?').get(email) as { id: number; email: string }
  const buy = (email: string, name: string, key: string, qty: number, level?: string) => {
    const u = user(email)
    const owner = { sessionToken: `${key}-session`, userId: u.id }
    const levelId = level ? (db.prepare('SELECT id FROM price_levels WHERE event_id = ? AND name = ?').get(ev.id, level) as { id: number }).id : undefined
    const held = holdBestAvailable(ev.id, owner, qty, levelId)
    finalize({ holdId: held.holdId, sessionToken: owner.sessionToken, userId: u.id, email: u.email, key, method: 'card', brand: 'Visa', last4: '4242', exp: '12/39', save: false, billing: { name, address: '1 Main St', city: 'New York', zip: '10001' } })
  }
  buy('fan@ticketstorm.test', 'Frankie Fan', 'seed-fan-order-2', 2)
  // 5 Premium seats: $500+ face on a brand-new account scores 60, over the review threshold of 50
  buy('fan2@ticketstorm.test', 'Fiona Fan', 'seed-fan2-order-2', 5, 'Premium')
  const status = (db.prepare("SELECT status FROM orders WHERE idempotency_key = 'seed-fan2-order-2'").get() as { status: string }).status
  if (status !== 'review') throw new Error(`seed: expected the Premium order to be in review, got ${status}`)
}
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('protection_pct', '8')").run()

console.log('Seeded: cities, venues, artists, events, users (password: password123).')
