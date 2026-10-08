import Link from 'next/link'
import type { EventRow } from '../lib/events.ts'
import { eventState } from '../lib/events.ts'
import { fmtDateTime, money } from '../lib/format.ts'

export default function EventCard({ e }: { e: EventRow }) {
  const s = eventState(e)
  return (
    <div className="card">
      <Link href={`/events/${e.slug}`}><strong>{e.title}</strong></Link> <span className={`badge ${s.label.toLowerCase().replace(' ', '-')}`}>{s.label}</span>
      <div className="muted">{e.venue}, {e.city} · {fmtDateTime(e.starts_at, e.tz)}</div>
      {e.min_cents !== null && (
        <div>{e.min_cents === e.max_cents ? money(e.min_cents) : `${money(e.min_cents)} – ${money(e.max_cents!)}`}</div>
      )}
    </div>
  )
}
