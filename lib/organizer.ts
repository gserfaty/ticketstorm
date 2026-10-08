import { randomBytes } from 'node:crypto'
import { db, tx } from './db.ts'
import { CATEGORIES } from './events.ts'
import { slugify } from './format.ts'
import { generateInventory } from './inventory.ts'
import { notify, sendEmail, APP_URL } from './notify.ts'
import { flagOn, UserError } from './platform.ts'
import { generateVenue, venueCapacity } from './venue-gen.ts'
import type { GenSection, VenueKind } from './venue-gen.ts'

// All functions here assume the caller already authorised the actor for the org that owns the event/venue.
// ids come in as eventId/venueId only; org ownership is always re-read from the row, never from the request.

export const MANAGE_ROLES = ['owner', 'manager']
export const SCAN_ROLES = ['owner', 'manager', 'box_office', 'scanner']
export const ALL_ROLES = ['owner', 'manager', 'box_office', 'scanner', 'finance']
export const BLOCK_KINDS = ['kill', 'comp', 'artist', 'promoter', 'production']
const TYPES = ['standard', 'vip', 'platinum', 'accessible', 'standing']

const unique = (name: string) => `${slugify(name) || 'item'}-${randomBytes(3).toString('hex')}`
const int = (v: unknown, min: number, max: number, what: string) => {
  const n = Number(v)
  if (v === '' || !Number.isInteger(n) || n < min || n > max) throw new UserError(`${what} must be a whole number from ${min} to ${max}`)
  return n
}

export const createOrg = (userId: number, name: string) =>
  tx(() => {
    if (!name || name.length > 80) throw new UserError('Organization name required (80 characters max)')
    const id = Number(db.prepare("INSERT INTO orgs (name, status) VALUES (?, 'pending')").run(name).lastInsertRowid)
    db.prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?,?,'owner')").run(id, userId)
    return id
  })

// ---- events ----
export type EventForm = { title: string; category: string; genre: string; venueId: number; startsAt: string | null; doorsAt: string | null; image: string; description: string }

function checkEvent(orgId: number, f: EventForm) {
  if (!f.title || f.title.length > 120) throw new UserError('Title required (120 characters max)')
  if (!CATEGORIES.some((c) => c.slug === f.category)) throw new UserError('Pick a category')
  if (!f.startsAt) throw new UserError('Enter a valid start date and time')
  if (f.image && !/^https?:\/\//.test(f.image)) throw new UserError('Image must be an http(s) URL')
  if (!db.prepare('SELECT 1 FROM venues WHERE id = ? AND org_id = ?').get(f.venueId, orgId)) throw new UserError('Pick one of your venues')
}

export function createEvent(orgId: number, f: EventForm): number {
  checkEvent(orgId, f)
  return Number(
    db
      .prepare(
        `INSERT INTO events (org_id, venue_id, slug, title, category, genre, starts_at, doors_at, image, description, status, info)
         VALUES (?,?,?,?,?,?,?,?,?,?, 'draft', '{}')`,
      )
      .run(orgId, f.venueId, unique(f.title), f.title, f.category, f.genre || null, f.startsAt, f.doorsAt, f.image || null, f.description || null).lastInsertRowid,
  )
}

// Venue and start time are only editable while a draft; after that use reschedule.
export function updateEvent(eventId: number, f: EventForm) {
  const ev = db.prepare('SELECT org_id, status, venue_id, starts_at FROM events WHERE id = ?').get(eventId) as { org_id: number; status: string; venue_id: number; starts_at: string }
  const draft = ev.status === 'draft'
  checkEvent(ev.org_id, { ...f, venueId: draft ? f.venueId : ev.venue_id, startsAt: draft ? f.startsAt : ev.starts_at })
  db.prepare('UPDATE events SET title=?, category=?, genre=?, image=?, description=?, doors_at=?, venue_id=?, starts_at=? WHERE id = ?').run(
    f.title, f.category, f.genre || null, f.image || null, f.description || null, f.doorsAt, draft ? f.venueId : ev.venue_id, draft ? f.startsAt : ev.starts_at, eventId,
  )
}

// draft -> published. Pending/suspended orgs cannot publish. With flag require_event_approval the event stays hidden until admin approves.
export function publishEvent(eventId: number) {
  tx(() => {
    const ev = db.prepare('SELECT e.status, e.starts_at, e.venue_id, o.status AS org_status FROM events e JOIN orgs o ON o.id = e.org_id WHERE e.id = ?').get(eventId) as
      | { status: string; starts_at: string; venue_id: number; org_status: string }
      | undefined
    if (!ev) throw new UserError('Event not found')
    if (ev.org_status !== 'approved') throw new UserError('Your organization is awaiting admin approval and cannot publish yet')
    if (ev.status !== 'draft') throw new UserError('Only drafts can be published')
    if (Date.parse(ev.starts_at) < Date.now()) throw new UserError('The event date is in the past')
    if (!db.prepare('SELECT 1 FROM price_levels WHERE event_id = ?').get(eventId)) throw new UserError('Add at least one price level first')
    if (!db.prepare('SELECT 1 FROM sections WHERE venue_id = ?').get(ev.venue_id)) throw new UserError('The venue has no seating chart')
    db.prepare("UPDATE events SET status = 'published', approved = ? WHERE id = ?").run(flagOn('require_event_approval') ? 0 : 1, eventId)
    generateInventory(eventId)
  })
}

// Tickets stay valid. postponed = no new date yet; rescheduled = new date (doors move with it). Holders are told.
export function changeDate(eventId: number, kind: 'postponed' | 'rescheduled', newStart?: string | null) {
  tx(() => {
    const ev = db.prepare('SELECT title, status, starts_at, doors_at FROM events WHERE id = ?').get(eventId) as { title: string; status: string; starts_at: string; doors_at: string | null }
    if (!['published', 'postponed', 'rescheduled'].includes(ev.status)) throw new UserError('Only published events can be postponed or rescheduled')
    let starts = ev.starts_at
    let doors = ev.doors_at
    if (kind === 'rescheduled') {
      if (!newStart || Date.parse(newStart) < Date.now()) throw new UserError('Enter a new date in the future')
      if (newStart === ev.starts_at && ev.status === 'rescheduled') return
      if (doors) doors = new Date(Date.parse(doors) + Date.parse(newStart) - Date.parse(ev.starts_at)).toISOString()
      starts = newStart
    } else if (ev.status === 'postponed') return
    db.prepare('UPDATE events SET status = ?, starts_at = ?, doors_at = ? WHERE id = ?').run(kind, starts, doors, eventId)
    const when = kind === 'rescheduled' ? `new date: ${starts}` : 'new date to be announced'
    const holders = db
      .prepare(
        `SELECT DISTINCT o.id, o.email, o.user_id, o.access_token FROM tickets t JOIN orders o ON o.id = t.order_id JOIN inventory i ON i.id = t.inventory_id
         WHERE i.event_id = ? AND t.status IN ('valid','listed')`,
      )
      .all(eventId) as { id: number; email: string; user_id: number | null; access_token: string }[]
    for (const h of holders) {
      sendEmail(h.email, `${ev.title} has been ${kind}`, `${ev.title} has been ${kind} (${when}). Your tickets remain valid.\n${APP_URL}/orders/${h.id}${h.user_id ? '' : `?t=${h.access_token}`}`)
      if (h.user_id) notify(h.user_id, 'order', `${ev.title} has been ${kind}`, 'Your tickets remain valid.', `/orders/${h.id}`)
    }
  })
}

// ---- pricing ----
export function addLevel(eventId: number, name: string, dollars: string, type: string, color: string) {
  if (!name || name.length > 40) throw new UserError('Level name required')
  if (!TYPES.includes(type)) throw new UserError('Unknown ticket type')
  const cents = Math.round(Number(dollars) * 100)
  if (!Number.isFinite(cents) || cents < 0 || cents > 10_000_000) throw new UserError('Enter a price')
  if (db.prepare('SELECT 1 FROM price_levels WHERE event_id = ? AND name = ?').get(eventId, name)) throw new UserError('A level with that name exists')
  db.prepare('INSERT INTO price_levels (event_id, name, color, price_cents, ticket_type) VALUES (?,?,?,?,?)').run(eventId, name, /^#[0-9a-f]{6}$/i.test(color) ? color : '#3b82f6', cents, type)
}

export function removeLevel(eventId: number, levelId: number) {
  if (db.prepare('SELECT 1 FROM inventory WHERE price_level_id = ? LIMIT 1').get(levelId)) throw new UserError('Level is in use by inventory; reassign seats first')
  db.prepare('DELETE FROM price_levels WHERE id = ? AND event_id = ?').run(levelId, eventId)
}

// Changing a price under live holds/sales would break open checkouts, so only unused levels can be re-priced.
export function repriceLevel(eventId: number, levelId: number, dollars: string) {
  const cents = Math.round(Number(dollars) * 100)
  if (!Number.isFinite(cents) || cents < 0 || cents > 10_000_000) throw new UserError('Enter a price')
  const r = db
    .prepare("UPDATE price_levels SET price_cents = ? WHERE id = ? AND event_id = ? AND NOT EXISTS (SELECT 1 FROM inventory WHERE price_level_id = price_levels.id AND status IN ('held','sold'))")
    .run(cents, levelId, eventId)
  if (!r.changes) throw new UserError('Level has held or sold tickets; its price is locked')
}

export function setFees(eventId: number, f: { service_pct: unknown; facility_cents: unknown; order_cents: unknown }) {
  const rule = { service_pct: int(f.service_pct, 0, 50, 'Service fee %'), facility_cents: int(f.facility_cents, 0, 100_000, 'Facility charge (cents)'), order_cents: int(f.order_cents, 0, 100_000, 'Order fee (cents)') }
  db.prepare('UPDATE events SET fee_rule = ? WHERE id = ?').run(JSON.stringify(rule), eventId)
}

export const setOnsale = (eventId: number, iso: string | null) => void db.prepare('UPDATE events SET onsale_at = ? WHERE id = ?').run(iso, eventId)

// ---- inventory ----
// op: a price level id, 'release', or a block_kind. Only free seats are touched (never held/sold). Blank row = whole section.
export function applyInventory(eventId: number, sectionId: number, row: string, op: string, levelId?: number): number {
  const ev = db.prepare('SELECT venue_id FROM events WHERE id = ?').get(eventId) as { venue_id: number }
  if (!db.prepare('SELECT 1 FROM sections WHERE id = ? AND venue_id = ?').get(sectionId, ev.venue_id)) throw new UserError('Unknown section')
  const where = `event_id = ? AND section_id = ? AND (? = '' OR seat_id IN (SELECT id FROM seats WHERE section_id = ? AND row = ?))`
  const args = [eventId, sectionId, row, sectionId, row]
  let r
  if (op === 'level') {
    if (!db.prepare('SELECT 1 FROM price_levels WHERE id = ? AND event_id = ?').get(levelId ?? null, eventId)) throw new UserError('Pick a price level')
    r = db.prepare(`UPDATE inventory SET price_level_id = ? WHERE ${where} AND status IN ('available','blocked')`).run(levelId!, ...args)
  } else if (op === 'release') {
    r = db.prepare(`UPDATE inventory SET status = 'available', block_kind = NULL WHERE ${where} AND status = 'blocked'`).run(...args)
  } else if (BLOCK_KINDS.includes(op)) {
    r = db.prepare(`UPDATE inventory SET status = 'blocked', block_kind = ?, hold_id = NULL, held_until = NULL WHERE ${where} AND status IN ('available','blocked')`).run(op, ...args)
  } else throw new UserError('Unknown action')
  return Number(r.changes)
}

// ---- venues ----
export const VENUE_KINDS: VenueKind[] = ['arena', 'stadium', 'theater', 'amphitheater', 'club']
const chartLocked = (venueId: number) => !!db.prepare('SELECT 1 FROM events WHERE venue_id = ? LIMIT 1').get(venueId)

function storeChart(venueId: number, secs: GenSection[]) {
  db.prepare('DELETE FROM seats WHERE section_id IN (SELECT id FROM sections WHERE venue_id = ?)').run(venueId)
  db.prepare('DELETE FROM sections WHERE venue_id = ?').run(venueId)
  const sec = db.prepare('INSERT INTO sections (venue_id, name, kind, capacity, path, label_x, label_y, rank) VALUES (?,?,?,?,?,?,?,?)')
  const seat = db.prepare('INSERT INTO seats (section_id, row, number, x, y, accessible, companion, obstructed) VALUES (?,?,?,?,?,?,?,?)')
  for (const s of secs) {
    const id = Number(sec.run(venueId, s.name, s.kind, s.capacity, s.path, s.label_x, s.label_y, s.rank).lastInsertRowid)
    for (const t of s.seats) seat.run(id, t.row, t.number, t.x, t.y, t.accessible, t.companion, t.obstructed)
  }
  db.prepare('UPDATE venues SET capacity = ? WHERE id = ?').run(venueCapacity(secs), venueId)
}

export function createVenue(orgId: number, f: { name: string; address: string; cityId: number; tz: string; kind: string }): number {
  if (!f.name || !f.address) throw new UserError('Name and address required')
  if (!VENUE_KINDS.includes(f.kind as VenueKind)) throw new UserError('Pick a layout')
  try { new Intl.DateTimeFormat('en-US', { timeZone: f.tz }) } catch { throw new UserError('Unknown time zone (e.g. America/Chicago)') }
  const city = db.prepare('SELECT lat, lng FROM cities WHERE id = ?').get(f.cityId) as { lat: number; lng: number } | undefined
  if (!city) throw new UserError('Pick a city')
  return tx(() => {
    const id = Number(
      db.prepare('INSERT INTO venues (org_id, slug, name, address, city_id, lat, lng, tz, info) VALUES (?,?,?,?,?,?,?,?,?)').run(orgId, unique(f.name), f.name, f.address, f.cityId, city.lat, city.lng, f.tz, '{}').lastInsertRowid,
    )
    storeChart(id, generateVenue(f.kind as VenueKind))
    return id
  })
}

export function regenerateChart(venueId: number, kind: string) {
  if (!VENUE_KINDS.includes(kind as VenueKind)) throw new UserError('Pick a layout')
  if (chartLocked(venueId)) throw new UserError('Events already use this venue; its chart is locked')
  tx(() => storeChart(venueId, generateVenue(kind as VenueKind)))
}

export function exportChart(venueId: number): GenSection[] {
  const secs = db.prepare('SELECT id, name, kind, capacity, path, label_x, label_y, rank FROM sections WHERE venue_id = ? ORDER BY rank, id').all(venueId) as (Omit<GenSection, 'seats'> & { id: number })[]
  return secs.map(({ id, ...s }) => ({
    ...s,
    seats: (db.prepare('SELECT row, number, x, y, accessible, companion, obstructed FROM seats WHERE section_id = ? ORDER BY row, number').all(id) as GenSection['seats']).map((x) => ({ ...x })),
  }))
}

export function importChart(venueId: number, text: string) {
  if (chartLocked(venueId)) throw new UserError('Events already use this venue; its chart is locked')
  let secs: GenSection[]
  try { secs = JSON.parse(text) } catch { throw new UserError('Not valid JSON') }
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
  const bit = (v: unknown) => v === 0 || v === 1
  const ok =
    Array.isArray(secs) && secs.length > 0 && secs.length <= 50 &&
    secs.every((s) =>
      typeof s?.name === 'string' && s.name && (s.kind === 'reserved' || s.kind === 'ga') && typeof s.path === 'string' && num(s.label_x) && num(s.label_y) && num(s.rank) &&
      (s.kind === 'ga' ? Number.isInteger(s.capacity) && s.capacity! > 0 && s.capacity! <= 20000 && s.seats?.length === 0 : s.capacity === null) &&
      Array.isArray(s.seats) && s.seats.length <= 5000 &&
      s.seats.every((t) => typeof t?.row === 'string' && Number.isInteger(t.number) && num(t.x) && num(t.y) && bit(t.accessible) && bit(t.companion) && bit(t.obstructed)),
    )
  if (!ok) throw new UserError('Chart JSON does not match the exported format')
  tx(() => storeChart(venueId, secs))
}

// Toggle a flag on seats `from`..`to` of a row (the chart is editable even after events exist: flags only affect filters/new inventory).
export function flagSeats(venueId: number, sectionId: number, row: string, from: number, to: number, flag: string, on: boolean): number {
  if (!['accessible', 'companion', 'obstructed'].includes(flag)) throw new UserError('Unknown flag')
  const r = db
    .prepare(`UPDATE seats SET ${flag} = ? WHERE section_id = ? AND row = ? AND number BETWEEN ? AND ? AND section_id IN (SELECT id FROM sections WHERE venue_id = ?)`)
    .run(on ? 1 : 0, sectionId, row, from, to, venueId)
  return Number(r.changes)
}

// ---- members ---- (tx: the last-owner check rolls the change back)
export const addMember = (orgId: number, email: string, role: string) =>
  tx(() => {
    if (!ALL_ROLES.includes(role)) throw new UserError('Unknown role')
    const u = db.prepare("SELECT id FROM users WHERE email = ? AND status = 'active'").get(email.toLowerCase()) as { id: number } | undefined
    if (!u) throw new UserError('No account with that email; ask them to sign up first')
    db.prepare('INSERT INTO org_members (org_id, user_id, role) VALUES (?,?,?) ON CONFLICT(org_id, user_id) DO UPDATE SET role = excluded.role').run(orgId, u.id, role)
    keepOwner(orgId)
  })

export const removeMember = (orgId: number, userId: number) =>
  tx(() => {
    db.prepare('DELETE FROM org_members WHERE org_id = ? AND user_id = ?').run(orgId, userId)
    keepOwner(orgId)
  })

function keepOwner(orgId: number) {
  if (!db.prepare("SELECT 1 FROM org_members WHERE org_id = ? AND role = 'owner'").get(orgId)) throw new UserError('An organization needs at least one owner')
}
