import Link from 'next/link'
import { notFound } from 'next/navigation'
import { eventState, getEvent } from '../../../lib/events.ts'
import { fmtDateTime, fmtDateTimeTz, money } from '../../../lib/format.ts'

export default async function EventPage({ params }: { params: Promise<{ slug: string }> }) {
  const e = getEvent((await params).slug)
  if (!e) notFound()
  const s = eventState(e!)
  const { levels } = e!
  const max = Math.min(e!.ticket_limit, 8)
  const notOnSale = e!.status === 'published' || e!.status === 'rescheduled' ? e!.onsale_at && Date.parse(e!.onsale_at) > Date.now() : false
  return (
    <>
      <h1>{e!.title} <span className={`badge ${s.label.toLowerCase().replace(' ', '-')}`}>{s.label}</span></h1>
      {e!.image && <img src={e!.image} alt="" className="hero-img" />}
      <p>{fmtDateTimeTz(e!.starts_at, e!.tz)}</p>
      {e!.doors_at && <p className="muted">Doors {fmtDateTime(e!.doors_at, e!.tz)}</p>}
      <p><Link href={`/venues/${e!.venue_slug}`}>{e!.venue}</Link> · {e!.address}, {e!.city}, {e!.state}</p>
      <p className="muted">Lineup: {e!.lineup.map((a) => a.name).join(', ')}</p>
      {e!.description && <p>{e!.description}</p>}
      {levels.length > 0 && (
        <>
          <h2>Tickets {levels.length > 1 && <span className="muted">{money(levels[0].price_cents)} – {money(levels[levels.length - 1].price_cents)}</span>}</h2>
          <ul>{levels.map((l) => <li key={l.id}>{l.name} ({l.ticket_type}) · {money(l.price_cents)}</li>)}</ul>
        </>
      )}
      {s.canBuy ? (
        <form action={`/events/${e!.slug}/tickets`} className="buy">
          <label>Quantity <select name="qty" defaultValue="2" aria-label="Quantity">
            {Array.from({ length: max }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
          </select></label>
          <button>Find tickets</button>
        </form>
      ) : notOnSale ? (
        <p><strong>On sale {fmtDateTime(e!.onsale_at!, e!.tz)}</strong></p>
      ) : (
        <p className="muted">Tickets are not available for this event.</p>
      )}
    </>
  )
}
