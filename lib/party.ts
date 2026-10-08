import { timingSafeEqual } from 'node:crypto'
import { db } from './db.ts'
import { mac } from './defense.ts'
import { ticketState } from './ticketstate.ts'

// "Share with your party": a read-only link to the seats one account holds for one event. The token is `userId.eventId.expiry.HMAC` (server
// secret), so it cannot be forged or pointed at another user or event. It shows seats and event info only: never a ticket secret, a QR code,
// an email address or a payment detail. It expires 12 hours after the show starts and cannot be revoked earlier (ponytail: rotate by changing the server secret).
const sign = (userId: number, eventId: number, exp: number) => mac(`party:${userId}:${eventId}:${exp}`).toString('hex')

export function partyToken(userId: number, eventId: number, startsAt: string): string {
  const exp = Date.parse(startsAt) + 12 * 3_600_000
  return `${userId}.${eventId}.${exp}.${sign(userId, eventId, exp)}`
}

export function verifyParty(token: string, now = Date.now()): { userId: number; eventId: number } | undefined {
  const m = /^(\d{1,12})\.(\d{1,12})\.(\d{10,15})\.([0-9a-f]{64})$/.exec(token)
  if (!m || Number(m[3]) < now) return undefined
  const want = Buffer.from(sign(Number(m[1]), Number(m[2]), Number(m[3])), 'hex')
  const got = Buffer.from(m[4], 'hex')
  return got.length === want.length && timingSafeEqual(got, want) ? { userId: Number(m[1]), eventId: Number(m[2]) } : undefined
}

export type Party = { title: string; venue: string; tz: string; starts_at: string; host: string; seats: { label: string; state: string }[] }

export function partyView(userId: number, eventId: number): Party | undefined {
  const e = db.prepare('SELECT e.title, e.starts_at, v.name AS venue, v.tz FROM events e JOIN venues v ON v.id = e.venue_id WHERE e.id = ?').get(eventId) as { title: string; starts_at: string; venue: string; tz: string } | undefined
  const u = db.prepare("SELECT name FROM users WHERE id = ? AND status = 'active'").get(userId) as { name: string } | undefined
  if (!e || !u) return undefined
  const rows = db
    .prepare(
      `SELECT t.status, o.status AS ostatus, s.name AS section, st.row, st.number FROM tickets t JOIN orders o ON o.id = t.order_id JOIN inventory i ON i.id = t.inventory_id
       JOIN sections s ON s.id = i.section_id LEFT JOIN seats st ON st.id = i.seat_id
       WHERE t.owner_id = ? AND i.event_id = ? AND t.status IN ('valid','used','listed') ORDER BY s.name, st.row, st.number, t.id`,
    )
    .all(userId, eventId) as { status: string; ostatus: string; section: string; row: string | null; number: number | null }[]
  return {
    ...e,
    host: u.name.split(' ')[0] || 'A friend',
    seats: rows.map((r) => ({ label: r.row ? `Section ${r.section} Row ${r.row} Seat ${r.number}` : `General admission ${r.section}`, state: ticketState(r.status, r.ostatus, e.starts_at) })),
  }
}
