import { db } from '../lib/db.ts'
import { fmtDateTime } from '../lib/format.ts'

type Row = { id: number; title: string; starts_at: string; venue: string; tz: string }

export default function Home() {
  const rows = db
    .prepare(
      `SELECT e.id, e.title, e.starts_at, v.name AS venue, v.tz FROM events e JOIN venues v ON v.id = e.venue_id
       WHERE e.status = 'published' AND e.starts_at > ? ORDER BY e.starts_at LIMIT 12`,
    )
    .all(new Date().toISOString()) as Row[]
  return (
    <>
      <h1>Upcoming events</h1>
      {rows.map((r) => (
        <div className="card" key={r.id}>
          <strong>{r.title}</strong>
          <div className="muted">{r.venue} · {fmtDateTime(r.starts_at, r.tz)}</div>
        </div>
      ))}
    </>
  )
}
