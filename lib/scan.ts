import { db } from './db.ts'
import { tokenTicketId, verifyToken, WINDOW_MS } from './safetix.ts'
import { fmtTime } from './format.ts'

export type ScanResult = { result: 'valid' | 'used' | 'expired' | 'invalid' | 'wrong_event'; message: string; ticketId?: number }

// Verify a SafeTix token for `eventId` and admit the ticket. Admission is ONE conditional UPDATE (status='valid'),
// so concurrent scans of the same ticket cannot both win, whatever connection they come from.
// `atMs` is when the code was scanned (offline queue replays pass the original time); it is clamped to the last day.
export function scanTicket(eventId: number, token: string, scannerId: number, atMs = Date.now()): ScanResult {
  const now = Date.now()
  const at = atMs > now + 60_000 || atMs < now - 86_400_000 ? now : atMs
  const id = tokenTicketId(token)
  const t = id
    ? (db
        .prepare(
          `SELECT t.id, t.status, t.secret, t.scanned_at, i.event_id, v.tz FROM tickets t JOIN inventory i ON i.id = t.inventory_id
           JOIN events e ON e.id = i.event_id JOIN venues v ON v.id = e.venue_id WHERE t.id = ?`,
        )
        .get(id) as { id: number; status: string; secret: string; scanned_at: string | null; event_id: number; tz: string } | undefined)
    : undefined
  if (!t) return { result: 'invalid', message: 'Invalid code' }
  if (t.event_id !== eventId) return { result: 'wrong_event', message: 'Ticket is for a different event', ticketId: t.id }
  if (!verifyToken(token, t.secret, at)) {
    // genuine HMAC but outside the +/-1 window = stale code (screenshot); anything else is forged
    return verifyToken(token, t.secret, Number(token.split('.')[1]) * WINDOW_MS)
      ? { result: 'expired', message: 'Expired code', ticketId: t.id }
      : { result: 'invalid', message: 'Invalid code' }
  }
  const r = db.prepare("UPDATE tickets SET status = 'used', scanned_at = ?, scanned_by = ? WHERE id = ? AND status = 'valid'").run(new Date(at).toISOString(), scannerId, t.id)
  if (r.changes === 1) return { result: 'valid', message: 'Valid', ticketId: t.id }
  const now2 = db.prepare('SELECT status, scanned_at FROM tickets WHERE id = ?').get(t.id) as { status: string; scanned_at: string | null }
  return now2.status === 'used' && now2.scanned_at
    ? { result: 'used', message: `Already used. Already scanned at ${fmtTime(now2.scanned_at, t.tz)}`, ticketId: t.id }
    : { result: 'invalid', message: `Ticket is ${now2.status}`, ticketId: t.id }
}

export function attendance(eventId: number) {
  return db
    .prepare(
      `SELECT coalesce(sum(t.status = 'used'), 0) AS scanned, count(*) AS total FROM tickets t JOIN inventory i ON i.id = t.inventory_id
       WHERE i.event_id = ? AND t.status IN ('valid','used','listed')`,
    )
    .get(eventId) as { scanned: number; total: number }
}
