import Link from 'next/link'
import { db } from '../../lib/db.ts'
import { fmtDateTime, money } from '../../lib/format.ts'
import { balance } from '../../lib/ledger.ts'
import { requireUser } from '../../lib/session.ts'
import { cancelListingAction } from '../resale/actions.ts'

export const dynamic = 'force-dynamic'

export default async function Listings({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const user = await requireUser()
  const { error, notice } = await searchParams
  const rows = db
    .prepare(
      `SELECT l.id, l.price_cents, l.status, e.title, e.starts_at, v.tz, s.name AS section, st.row, st.number
       FROM listings l JOIN tickets t ON t.id = l.ticket_id JOIN inventory i ON i.id = t.inventory_id JOIN events e ON e.id = i.event_id
       JOIN venues v ON v.id = e.venue_id JOIN sections s ON s.id = i.section_id LEFT JOIN seats st ON st.id = i.seat_id
       WHERE l.seller_id = ? ORDER BY l.id DESC`,
    )
    .all(user.id) as { id: number; price_cents: number; status: string; title: string; starts_at: string; tz: string; section: string; row: string | null; number: number | null }[]
  return (
    <>
      <h1>Your listings</h1>
      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}
      <p>Resale balance: <strong>{money(balance(`user:${user.id}`))}</strong> · <Link href="/sell">Sell a ticket</Link></p>
      {rows.map((l) => (
        <div className="card" key={l.id}>
          <strong>{l.title}</strong> · {fmtDateTime(l.starts_at, l.tz)} · {money(l.price_cents)} · <span className="badge">{l.status}</span>
          <div className="muted">{l.row ? `Section ${l.section} Row ${l.row} Seat ${l.number}` : `General admission ${l.section}`}</div>
          {l.status === 'active' && (
            <form action={cancelListingAction}>
              <input type="hidden" name="listingId" value={l.id} />
              <button>Cancel listing</button>
            </form>
          )}
        </div>
      ))}
      {rows.length === 0 && <p>No listings yet.</p>}
    </>
  )
}
