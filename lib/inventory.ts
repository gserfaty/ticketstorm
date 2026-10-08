import { db, tx } from './db.ts'
import { eventState } from './events.ts'

export class HoldError extends Error {
  status: number
  constructor(message: string, status = 409) {
    super(message)
    this.status = status
  }
}

export type Owner = { sessionToken: string; userId: number | null }
export type Held = { holdId: number; expiresAt: string; ids: number[] }

const marks = (n: number) => Array(n).fill('?').join(',')

// One row per reserved seat and per GA slot. Levels by section: accessible/companion seats -> Accessible,
// GA -> Standing, reserved by rank 1 VIP / 2 Premium / else General. `bundleSection` (a section name)
// gets the event's bundle level instead. Idempotent.
export function generateInventory(eventId: number, bundleSection: string | null = null) {
  const level = (name: string) => `(SELECT id FROM price_levels WHERE event_id = ev.id AND name = ${name})`
  // organizer-made events name their levels freely: anything unnamed starts on the cheapest level (re-assign in the inventory tool)
  const fallback = '(SELECT id FROM price_levels WHERE event_id = ev.id AND event_ids IS NULL ORDER BY price_cents, id LIMIT 1)'
  db.prepare(
    `INSERT OR IGNORE INTO inventory (event_id, section_id, seat_id, price_level_id)
     SELECT ev.id, s.id, st.id, coalesce(CASE
       WHEN st.accessible = 1 OR st.companion = 1 THEN ${level("'Accessible'")}
       WHEN s.name = ? THEN (SELECT id FROM price_levels WHERE event_id = ev.id AND event_ids IS NOT NULL)
       WHEN s.rank <= 1 THEN ${level("'VIP'")}
       WHEN s.rank = 2 THEN ${level("'Premium'")}
       ELSE ${level("'General'")} END, ${fallback})
     FROM events ev JOIN sections s ON s.venue_id = ev.venue_id JOIN seats st ON st.section_id = s.id WHERE ev.id = ?`,
  ).run(bundleSection, eventId)
  db.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < (SELECT coalesce(max(capacity), 0) FROM sections WHERE kind = 'ga'))
     INSERT OR IGNORE INTO inventory (event_id, section_id, seat_id, slot, price_level_id)
     SELECT ev.id, s.id, NULL, n.i, coalesce(${level("'Standing'")}, ${fallback})
     FROM events ev JOIN sections s ON s.venue_id = ev.venue_id AND s.kind = 'ga' JOIN n ON n.i <= s.capacity WHERE ev.id = ?`,
  ).run(eventId)
}

function free(holdId: number) {
  db.prepare("UPDATE holds SET status = 'released' WHERE id = ?").run(holdId)
  db.prepare("UPDATE inventory SET status = 'available', hold_id = NULL, held_until = NULL WHERE hold_id = ? AND status = 'held'").run(holdId)
}

// Every hold path ends here: ONE conditional UPDATE inside BEGIN IMMEDIATE, expiry folded into the predicate,
// all-or-nothing (changes !== ids.length -> throw -> ROLLBACK). `pick` chooses candidate ids inside the same tx.
function place(eventId: number, owner: Owner, qty: number, pick: () => number[]): Held {
  return tx(() => {
    const ev = db.prepare('SELECT id, status, starts_at, onsale_at, hold_minutes, ticket_limit FROM events WHERE id = ? AND approved = 1').get(eventId) as
      | { id: number; status: string; starts_at: string; onsale_at: string | null; hold_minutes: number; ticket_limit: number }
      | undefined
    if (!ev || ev.status === 'draft') throw new HoldError('Event not found', 404)
    if (!eventState(ev).canBuy) throw new HoldError('Tickets are not on sale for this event', 409)
    if (!Number.isInteger(qty) || qty < 1 || qty > ev.ticket_limit) throw new HoldError(`Choose 1 to ${ev.ticket_limit} tickets`, 400)

    const now = new Date()
    const nowIso = now.toISOString()
    // One live hold per session per event: a new hold replaces the old one, so ticket_limit can't be dodged by stacking holds.
    for (const h of db.prepare("SELECT id FROM holds WHERE session_token = ? AND event_id = ? AND status = 'active'").all(owner.sessionToken, eventId) as { id: number }[]) free(h.id)

    const ids = pick()
    const all = [...ids]
    const eventIds = new Set([eventId])
    // Bundle levels also hold the same seat in every other event of the bundle.
    const bundled = db
      .prepare(`SELECT i.seat_id, pl.event_ids FROM inventory i JOIN price_levels pl ON pl.id = i.price_level_id
                WHERE i.event_id = ? AND pl.event_ids IS NOT NULL AND i.id IN (${marks(ids.length)})`)
      .all(eventId, ...ids) as { seat_id: number; event_ids: string }[]
    for (const b of bundled) {
      for (const other of (JSON.parse(b.event_ids) as number[]).filter((e) => e !== eventId)) {
        const oe = db.prepare('SELECT status, starts_at, onsale_at, approved FROM events WHERE id = ?').get(other) as
          | { status: string; starts_at: string; onsale_at: string | null; approved: number }
          | undefined
        if (!oe || oe.status === 'draft' || !oe.approved || !eventState(oe).canBuy) throw new HoldError('A game in this bundle is not on sale')
        const row = db.prepare('SELECT id FROM inventory WHERE event_id = ? AND seat_id = ?').get(other, b.seat_id) as { id: number } | undefined
        if (!row) throw new HoldError('Bundle seat unavailable')
        all.push(row.id)
        eventIds.add(other)
      }
    }

    const expiresAt = new Date(now.getTime() + ev.hold_minutes * 60_000).toISOString()
    const holdId = Number(
      db.prepare('INSERT INTO holds (session_token, user_id, event_id, expires_at) VALUES (?,?,?,?)').run(owner.sessionToken, owner.userId, eventId, expiresAt).lastInsertRowid,
    )
    const r = db
      .prepare(
        `UPDATE inventory SET status = 'held', hold_id = ?, held_until = ?
         WHERE event_id IN (${marks(eventIds.size)}) AND id IN (${marks(all.length)}) AND window_id IS ? AND
           (status = 'available' OR (status = 'held' AND held_until < ?))`,
      )
      .run(holdId, expiresAt, ...eventIds, ...all, null, nowIso)
    if (r.changes !== all.length) throw new HoldError('Those tickets were just taken')
    return { holdId, expiresAt, ids }
  })
}

export function holdSeats(eventId: number, owner: Owner, seatIds: number[]): Held {
  const ids = [...new Set(seatIds)]
  if (ids.length !== seatIds.length) throw new HoldError('Duplicate seats', 400)
  return place(eventId, owner, ids.length, () => {
    const found = db.prepare(`SELECT id FROM inventory WHERE event_id = ? AND seat_id IS NOT NULL AND id IN (${marks(ids.length)})`).all(eventId, ...ids)
    if (found.length !== ids.length) throw new HoldError('Unknown seat', 400)
    return ids
  })
}

// First run of `qty` consecutive seat numbers in one row, best section rank first. ADA seats are kept for accessible requests.
export function holdBestAvailable(eventId: number, owner: Owner, qty: number, levelId?: number, accessible = false): Held {
  return place(eventId, owner, qty, () => {
    const args: (string | number)[] = [eventId, new Date().toISOString()]
    if (levelId) args.push(levelId)
    const rows = db
      .prepare(
        `SELECT i.id, i.section_id, st.row, st.number FROM inventory i JOIN seats st ON st.id = i.seat_id JOIN sections s ON s.id = i.section_id
         JOIN price_levels pl ON pl.id = i.price_level_id
         WHERE i.event_id = ? AND i.window_id IS NULL AND (i.status = 'available' OR (i.status = 'held' AND i.held_until < ?))
           ${levelId ? 'AND i.price_level_id = ?' : 'AND pl.event_ids IS NULL'} AND ${accessible ? '(st.accessible = 1 OR st.companion = 1)' : 'st.accessible = 0 AND st.companion = 0'}
         ORDER BY s.rank, s.id, st.row, st.number`,
      )
      .all(...args) as { id: number; section_id: number; row: string; number: number }[]
    let run: typeof rows = []
    for (const r of rows) {
      const prev = run[run.length - 1]
      run = prev && prev.section_id === r.section_id && prev.row === r.row && prev.number === r.number - 1 ? [...run, r] : [r]
      if (run.length === qty) return run.map((x) => x.id)
    }
    throw new HoldError(`No ${qty} adjacent seats available`)
  })
}

export function holdGA(eventId: number, owner: Owner, sectionId: number, qty: number): Held {
  return place(eventId, owner, qty, () => {
    if (!db.prepare("SELECT 1 FROM inventory WHERE event_id = ? AND section_id = ? AND seat_id IS NULL LIMIT 1").get(eventId, sectionId)) throw new HoldError('Unknown section', 400)
    const rows = db
      .prepare(
        `SELECT id FROM inventory WHERE event_id = ? AND section_id = ? AND seat_id IS NULL AND window_id IS NULL
           AND (status = 'available' OR (status = 'held' AND held_until < ?)) ORDER BY slot LIMIT ?`,
      )
      .all(eventId, sectionId, new Date().toISOString(), qty) as { id: number }[]
    if (rows.length < qty) throw new HoldError(`Only ${rows.length} left in this area`)
    return rows.map((r) => r.id)
  })
}

// Only the owning session can release. Returns false if not found / not yours / already released.
export function releaseHold(holdId: number, sessionToken: string): boolean {
  return tx(() => {
    const h = db.prepare("SELECT id FROM holds WHERE id = ? AND session_token = ? AND status = 'active'").get(holdId, sessionToken)
    if (h) free(holdId)
    return !!h
  })
}

// Compact availability. Seats: [id, a|h|s|b, levelId]; GA is summarised per section (a slot-per-row list would be thousands of rows).
export function getAvailability(eventId: number) {
  const now = new Date().toISOString()
  const seats = db
    .prepare(
      `SELECT id, CASE WHEN window_id IS NOT NULL THEN 'b' WHEN status = 'held' THEN CASE WHEN held_until < ? THEN 'a' ELSE 'h' END ELSE substr(status, 1, 1) END AS st, price_level_id AS lv
       FROM inventory WHERE event_id = ? AND seat_id IS NOT NULL ORDER BY id`,
    )
    .all(now, eventId) as { id: number; st: string; lv: number }[]
  const ga = db
    .prepare(
      `SELECT section_id AS sectionId, price_level_id AS levelId, count(*) AS total,
         sum(window_id IS NULL AND (status = 'available' OR (status = 'held' AND held_until < ?))) AS free
       FROM inventory WHERE event_id = ? AND seat_id IS NULL GROUP BY section_id, price_level_id`,
    )
    .all(now, eventId) as { sectionId: number; levelId: number; total: number; free: number }[]
  // node:sqlite rows have a null prototype; spread so they can cross into client components
  return { seats: seats.map((s) => [s.id, s.st, s.lv] as const), ga: ga.map((g) => ({ ...g })) }
}

// Nothing available and nothing merely held (held tickets may come back).
export function isSoldOut(eventId: number): boolean {
  const r = db
    .prepare(`SELECT count(*) AS n, sum(status IN ('available','held')) AS open FROM inventory WHERE event_id = ?`)
    .get(eventId) as { n: number; open: number | null }
  return r.n > 0 && !r.open
}

// The session's live hold on an event, to restore the map after a reload.
export function activeHold(sessionToken: string, eventId: number) {
  const h = db
    .prepare("SELECT id, expires_at FROM holds WHERE session_token = ? AND event_id = ? AND status = 'active' AND expires_at > ? ORDER BY id DESC LIMIT 1")
    .get(sessionToken, eventId, new Date().toISOString()) as { id: number; expires_at: string } | undefined
  if (!h) return undefined
  const rows = db.prepare("SELECT id, section_id, seat_id FROM inventory WHERE hold_id = ? AND event_id = ? AND status = 'held'").all(h.id, eventId) as {
    id: number
    section_id: number
    seat_id: number | null
  }[]
  const ga = rows.filter((r) => r.seat_id === null)
  return {
    id: h.id,
    expiresAt: h.expires_at,
    seatIds: rows.filter((r) => r.seat_id !== null).map((r) => r.id),
    ga: ga.length ? { sectionId: ga[0].section_id, qty: ga.length } : null,
  }
}
