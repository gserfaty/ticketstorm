import Link from 'next/link'
import Flash from '../../../../../../components/Flash.tsx'
import { db } from '../../../../../../lib/db.ts'
import { BLOCK_KINDS } from '../../../../../../lib/organizer.ts'
import { loadEvent } from '../../../../guard.ts'
import { inventoryAction } from '../../../../actions.ts'

export const dynamic = 'force-dynamic'

export default async function Inventory({ params, searchParams }: { params: Promise<{ orgId: string; id: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const { orgId, id } = await params
  const { e } = await loadEvent(orgId, id)
  const sections = db.prepare('SELECT id, name, kind FROM sections WHERE venue_id = ? ORDER BY rank, id').all(e.venue_id) as { id: number; name: string; kind: string }[]
  const levels = db.prepare('SELECT id, name FROM price_levels WHERE event_id = ? AND event_ids IS NULL ORDER BY price_cents').all(e.id) as { id: number; name: string }[]
  const rows = db
    .prepare(
      `SELECT s.name AS section, coalesce(st.row, '(GA)') AS row, count(*) AS n, pl.name AS level,
         sum(i.status = 'available') AS free, sum(i.status = 'blocked') AS blocked, sum(i.status = 'sold') AS sold
       FROM inventory i JOIN sections s ON s.id = i.section_id LEFT JOIN seats st ON st.id = i.seat_id JOIN price_levels pl ON pl.id = i.price_level_id
       WHERE i.event_id = ? GROUP BY s.id, st.row, pl.id ORDER BY s.rank, s.id, st.row`,
    )
    .all(e.id) as { section: string; row: string; n: number; level: string; free: number; blocked: number; sold: number }[]
  return (
    <>
      <h1>Inventory: {e.title}</h1>
      <p><Link href={`/organizer/${orgId}/events/${e.id}`}>Back to event</Link></p>
      <Flash {...(await searchParams)} />
      {e.status === 'draft' ? <p className="muted">Publishing the event creates its inventory.</p> : (
        <form action={inventoryAction} className="filters">
          <input type="hidden" name="eventId" value={e.id} />
          <input type="hidden" name="page" value="inventory" />
          <select name="sectionId" aria-label="Section">{sections.map((s) => <option key={s.id} value={s.id}>{s.name}{s.kind === 'ga' ? ' (GA)' : ''}</option>)}</select>
          <input name="row" placeholder="Row (blank = whole section)" aria-label="Row" />
          <select name="op" aria-label="Action">
            <option value="level">Assign price level</option>
            {BLOCK_KINDS.map((k) => <option key={k} value={k}>{k === 'kill' ? 'Kill (block)' : `Block: ${k}`}</option>)}
            <option value="release">Release blocked</option>
          </select>
          <select name="levelId" aria-label="Price level">{levels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
          <button>Apply</button>
        </form>
      )}
      <p className="muted">Held and sold seats are never changed.</p>
      <table>
        <thead><tr><td>Section</td><td>Row</td><td>Level</td><td>Total</td><td>Free</td><td>Blocked</td><td>Sold</td></tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}><td>{r.section}</td><td>{r.row}</td><td>{r.level}</td><td>{r.n}</td><td>{r.free}</td><td>{r.blocked}</td><td>{r.sold}</td></tr>)}</tbody>
      </table>
    </>
  )
}
