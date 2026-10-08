import Link from 'next/link'
import type { EventRow } from '../lib/events.ts'
import { eventState } from '../lib/events.ts'
import Heart from './Heart.tsx'
import { fmtDateTime, money } from '../lib/format.ts'
import { displayRange } from '../lib/pricing.ts'
import { allInOn } from '../lib/session.ts'

export default async function EventCard({ e }: { e: EventRow }) {
  const s = eventState(e)
  const range = displayRange(e.id, await allInOn())
  return (
    <div className="card">
      <Link href={`/events/${e.slug}`}><strong>{e.title}</strong></Link> <span className={`badge ${s.label.toLowerCase().replace(' ', '-')}`}>{s.label}</span> <Heart kind="event" id={e.id} label={e.title} />
      <div className="muted">{e.venue}, {e.city} · {fmtDateTime(e.starts_at, e.tz)}</div>
      {range && <div>{range[0] === range[1] ? money(range[0]) : `${money(range[0])} – ${money(range[1])}`}</div>}
    </div>
  )
}
