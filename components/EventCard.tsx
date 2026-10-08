import Link from 'next/link'
import type { EventRow } from '../lib/events.ts'
import { eventState } from '../lib/events.ts'
import Heart from './Heart.tsx'
import { fmtDateTime, money } from '../lib/format.ts'
import { displayRange } from '../lib/pricing.ts'
import { allInOn, currencyPref } from '../lib/session.ts'
import { approx } from '../lib/currency.ts'

export default async function EventCard({ e }: { e: EventRow }) {
  const s = eventState(e)
  const range = displayRange(e.id, await allInOn())
  const cur = await currencyPref()
  return (
    <div className="card">
      <Link href={`/events/${e.slug}`}><strong>{e.title}</strong></Link> <span className={`badge ${s.label.toLowerCase().replace(' ', '-')}`}>{s.label}</span> <Heart kind="event" id={e.id} label={e.title} />
      <div className="muted"><Link href={`/venues/${e.venue_slug}`}>{e.venue}</Link>, {e.city} · {fmtDateTime(e.starts_at, e.tz)}{e.hl_slug && <> · <Link href={`/artists/${e.hl_slug}`}>{e.hl_name}</Link></>}</div>
      {range && <div>{range[0] === range[1] ? money(range[0]) : `${money(range[0])} – ${money(range[1])}`} <span className="muted" title="Approximate; charged in USD">{approx(range[0], cur)}{range[0] !== range[1] && cur !== 'USD' ? ` – ${approx(range[1], cur).replace('≈ ', '')}` : ''}</span></div>}
    </div>
  )
}
