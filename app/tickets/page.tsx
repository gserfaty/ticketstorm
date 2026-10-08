import Link from 'next/link'
import { db } from '../../lib/db.ts'
import { fmtDateTime } from '../../lib/format.ts'
import { requireUser } from '../../lib/session.ts'

export const dynamic = 'force-dynamic'

export default async function Tickets() {
  const user = await requireUser()
  const rows = db
    .prepare(
      `SELECT t.id, t.status, e.title, e.starts_at, v.name AS venue, v.tz, s.name AS section, st.row, st.number
       FROM tickets t JOIN inventory i ON i.id = t.inventory_id JOIN events e ON e.id = i.event_id JOIN venues v ON v.id = e.venue_id
       JOIN sections s ON s.id = i.section_id LEFT JOIN seats st ON st.id = i.seat_id
       WHERE t.owner_id = ? AND t.status IN ('valid','used','listed') AND e.starts_at >= ? ORDER BY e.starts_at, t.id`,
    )
    .all(user.id, new Date(Date.now() - 6 * 3_600_000).toISOString()) as { id: number; status: string; title: string; starts_at: string; venue: string; tz: string; section: string; row: string | null; number: number | null }[]
  return (
    <>
      <h1>My tickets</h1>
      {rows.map((t) => (
        <div className="card" key={t.id}>
          <Link href={`/tickets/${t.id}`}>{t.title}</Link> · {t.venue} · {fmtDateTime(t.starts_at, t.tz)}
          <div className="muted">{t.row ? `Section ${t.section} Row ${t.row} Seat ${t.number}` : `General admission ${t.section}`} · {t.status}</div>
        </div>
      ))}
      {rows.length === 0 && <p>No upcoming tickets.</p>}
    </>
  )
}
