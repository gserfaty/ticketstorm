import { randomInt } from 'node:crypto'
import { db, tx } from './db.ts'
import { UserError } from './platform.ts'

export const ADMIT_MINUTES = 10
const DEFAULT_RATE = 60 // admissions per minute after on-sale
const DEFAULT_CAP = 200 // shoppers inside at once

type Ev = { created_at: string; onsale_at: string | null; queue_enabled: number; queue_rate: number | null; queue_cap: number | null }
const getEv = (eventId: number) =>
  db.prepare('SELECT created_at, onsale_at, queue_enabled, queue_rate, queue_cap FROM events WHERE id = ?').get(eventId) as Ev | undefined
const iso = (ms: number) => new Date(ms).toISOString()

// Lazy admission, run inside a tx on every poll/gate check: admit in rank order up to
//   rate x minutes since on-sale  (cumulative)   and   cap  (admitted AND unexpired).
function admit(eventId: number, ev: Ev, now: number) {
  const start = Date.parse(ev.onsale_at ?? ev.created_at)
  if (start > now) return
  const rate = ev.queue_rate ?? DEFAULT_RATE
  const cap = ev.queue_cap ?? DEFAULT_CAP
  const t = db
    .prepare('SELECT count(*) AS total, coalesce(sum(expires_at > ?), 0) AS live FROM queue_entries WHERE event_id = ? AND admitted_at IS NOT NULL')
    .get(iso(now), eventId) as { total: number; live: number }
  const slots = Math.min(Math.floor((rate * (now - start)) / 60_000) - t.total, cap - t.live)
  if (slots > 0)
    db.prepare(
      `UPDATE queue_entries SET admitted_at = ?, expires_at = ?
       WHERE id IN (SELECT id FROM queue_entries WHERE event_id = ? AND admitted_at IS NULL ORDER BY rank, id LIMIT ?)`,
    ).run(iso(now), iso(now + ADMIT_MINUTES * 60_000), eventId, slots)
}

// Same session -> same entry (refresh and re-join keep the place). Before on-sale the rank is random, after it is FIFO.
// An expired shopping window is dropped, so re-joining goes to the back.
export function joinQueue(eventId: number, sessionToken: string, userId: number | null, now = Date.now()) {
  tx(() => {
    const ev = getEv(eventId)
    if (!ev?.queue_enabled) throw new UserError('This event has no waiting room')
    const mine = db.prepare('SELECT id, admitted_at, expires_at FROM queue_entries WHERE event_id = ? AND session_token = ?').get(eventId, sessionToken) as
      | { id: number; admitted_at: string | null; expires_at: string | null }
      | undefined
    if (mine && !(mine.admitted_at && mine.expires_at! <= iso(now))) return
    if (mine) db.prepare('DELETE FROM queue_entries WHERE id = ?').run(mine.id)
    const pre = !!ev.onsale_at && Date.parse(ev.onsale_at) > now
    const rank = pre ? randomInt(1, 1_000_000_000) : ((db.prepare('SELECT max(rank) AS m FROM queue_entries WHERE event_id = ?').get(eventId) as { m: number | null }).m ?? 0) + 1
    db.prepare('INSERT INTO queue_entries (event_id, session_token, user_id, rank, joined_at) VALUES (?,?,?,?,?)').run(eventId, sessionToken, userId, rank, iso(now))
  })
}

export type QueueStatus =
  | { state: 'none' | 'expired' }
  | { state: 'waiting'; position: number; waitMinutes: number; ahead: number }
  | { state: 'admitted'; expiresAt: string }

// Gate check; the caller must already be inside tx(). Runs admission first so a poll-free visitor can't be stuck behind lazy state.
export function admittedNow(eventId: number, sessionToken: string, now = Date.now()): boolean {
  const ev = getEv(eventId)
  if (!ev?.queue_enabled) return true
  admit(eventId, ev, now)
  return !!db.prepare('SELECT 1 FROM queue_entries WHERE event_id = ? AND session_token = ? AND admitted_at IS NOT NULL AND expires_at > ?').get(eventId, sessionToken, iso(now))
}

export const isAdmitted = (eventId: number, sessionToken: string, now = Date.now()) => tx(() => admittedNow(eventId, sessionToken, now))

export function queueStatus(eventId: number, sessionToken: string, now = Date.now()): QueueStatus {
  return tx(() => {
    const ev = getEv(eventId)
    if (!ev?.queue_enabled) return { state: 'none' as const }
    admit(eventId, ev, now)
    const e = db.prepare('SELECT id, rank, admitted_at, expires_at FROM queue_entries WHERE event_id = ? AND session_token = ?').get(eventId, sessionToken) as
      | { id: number; rank: number; admitted_at: string | null; expires_at: string | null }
      | undefined
    if (!e) return { state: 'none' as const }
    if (e.admitted_at) return e.expires_at! > iso(now) ? { state: 'admitted' as const, expiresAt: e.expires_at! } : { state: 'expired' as const }
    const ahead = (db
      .prepare('SELECT count(*) AS n FROM queue_entries WHERE event_id = ? AND admitted_at IS NULL AND (rank < ? OR (rank = ? AND id < ?))')
      .get(eventId, e.rank, e.rank, e.id) as { n: number }).n
    const untilSale = Math.max(0, Date.parse(ev.onsale_at ?? ev.created_at) - now) / 60_000
    return { state: 'waiting' as const, position: ahead + 1, ahead, waitMinutes: Math.ceil(untilSale + (ahead + 1) / (ev.queue_rate ?? DEFAULT_RATE)) }
  })
}
