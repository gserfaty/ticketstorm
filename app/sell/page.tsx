import Link from 'next/link'
import { db } from '../../lib/db.ts'
import { fmtDateTime } from '../../lib/format.ts'
import { requireUser } from '../../lib/session.ts'
import { sellTicket } from '../resale/actions.ts'

export const dynamic = 'force-dynamic'

export default async function Sell({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await requireUser()
  const { error } = await searchParams
  const now = new Date().toISOString()
  const rows = db
    .prepare(
      `SELECT t.id, e.title, e.starts_at, v.tz, s.name AS section, st.row, st.number
       FROM tickets t JOIN inventory i ON i.id = t.inventory_id JOIN events e ON e.id = i.event_id JOIN venues v ON v.id = e.venue_id
       JOIN sections s ON s.id = i.section_id LEFT JOIN seats st ON st.id = i.seat_id
       WHERE t.owner_id = ? AND t.status = 'valid' AND e.status != 'cancelled' AND e.starts_at > ?
         AND NOT EXISTS (SELECT 1 FROM transfers x WHERE x.ticket_id = t.id AND x.status = 'pending' AND x.expires_at > ?) ORDER BY e.starts_at, t.id`,
    )
    .all(user.id, now, now) as { id: number; title: string; starts_at: string; tz: string; section: string; row: string | null; number: number | null }[]
  return (
    <>
      <h1>Sell tickets</h1>
      {error && <p className="error">{error}</p>}
      <p><Link href="/listings">Your listings</Link></p>
      {rows.map((t) => (
        <form action={sellTicket} className="card" key={t.id}>
          <input type="hidden" name="ticketId" value={t.id} />
          <strong>{t.title}</strong> · {fmtDateTime(t.starts_at, t.tz)}
          <div className="muted">{t.row ? `Section ${t.section} Row ${t.row} Seat ${t.number}` : `General admission ${t.section}`}</div>
          <label>Price $ <input name="price" inputMode="decimal" placeholder="75.00" required pattern="\d{1,6}(\.\d{1,2})?" size={8} /></label> <button>List for resale</button>
        </form>
      ))}
      {rows.length === 0 && <p>No tickets available to sell.</p>}
    </>
  )
}
