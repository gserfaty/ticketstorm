import { notFound, redirect } from 'next/navigation'
import { db } from '../../../../lib/db.ts'
import { eventState, getEvent, orderLimit } from '../../../../lib/events.ts'
import { openWindowIds } from '../../../../lib/access.ts'
import { activeHold, getAvailability, isSoldOut } from '../../../../lib/inventory.ts'
import { isAdmitted } from '../../../../lib/queue.ts'
import { activeListings } from '../../../../lib/resale.ts'
import { displayLevels, pricingCtx, shown } from '../../../../lib/pricing.ts'
import { allInOn, getSession, getUser } from '../../../../lib/session.ts'
import { money } from '../../../../lib/format.ts'
import { buyListing } from '../../../resale/actions.ts'
import SeatMap from '../../../../components/SeatMap.tsx'
import type { MapSeat, MapSection } from '../../../../components/SeatMap.tsx'

export const dynamic = 'force-dynamic'

export default async function Tickets({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ qty?: string; error?: string }> }) {
  const { slug } = await params
  const e = getEvent(slug)
  if (!e) notFound()
  const token = (await getSession())?.token
  const win = openWindowIds(e!.id, token)
  const st = eventState(e!)
  // an unlocked presale gets in without the waiting room, and before the public on-sale
  if (!st.canBuy && !(win.length && st.label === 'Upcoming')) redirect(`/events/${slug}`)
  if (e!.queue_enabled && !win.length && !(token && isAdmitted(e!.id, token))) redirect(`/queue/${e!.id}`)
  const sp = await searchParams
  const limit = orderLimit(e!)
  const allIn = await allInOn()
  const ctx = pricingCtx(e!.id)
  const qty = Math.min(Math.max(parseInt(sp.qty ?? '', 10) || 2, 1), limit)
  const listings = activeListings(e!.id, (await getUser())?.id ?? null)
  const back = `/events/${slug}/tickets`
  const resale = (
    <>
      {sp.error && <p className="error">{sp.error}</p>}
      {listings.length > 0 && (
        <>
          <h2>Verified Resale</h2>
          <p className="muted">Tickets from other fans, sold through TicketStorm. Each has a new barcode.</p>
          {listings.map((l) => (
            <form action={buyListing} className="card row" key={l.id}>
              <input type="hidden" name="listingId" value={l.id} />
              <input type="hidden" name="back" value={back} />
              {l.row ? `Section ${l.section} Row ${l.row} Seat ${l.number}` : `General admission ${l.section}`} · {money(shown(l.price_cents, ctx, allIn))}{' '}
              {l.mine ? <span className="muted">Your listing</span> : l.held ? <span className="muted">Someone is checking out</span> : <button>Buy</button>}
            </form>
          ))}
        </>
      )}
    </>
  )
  if (isSoldOut(e!.id)) return <><h1>{e!.title}</h1><p><strong>Sold out.</strong></p>{resale}</>

  const sections = (
    db
      .prepare('SELECT s.id, s.name, s.kind, s.path, s.label_x AS lx, s.label_y AS ly, s.rank FROM sections s JOIN events ev ON ev.venue_id = s.venue_id WHERE ev.id = ? ORDER BY s.rank, s.id')
      .all(e!.id) as MapSection[]
  ).map((s) => ({ ...s }))
  const seats = (
    db
      .prepare(
        `SELECT i.id, i.section_id, st.row, st.number, st.x, st.y, st.accessible + 2 * st.companion AS flags
         FROM inventory i JOIN seats st ON st.id = i.seat_id WHERE i.event_id = ? ORDER BY i.section_id, st.row, st.number`,
      )
      .all(e!.id) as { id: number; section_id: number; row: string; number: number; x: number; y: number; flags: number }[]
  ).map((r): MapSeat => [r.id, r.section_id, r.row, r.number, r.x, r.y, r.flags])
  const levels = displayLevels(e!.id, allIn).map((l) => ({ id: l.id, name: l.name, color: l.color, cents: l.cents, type: l.ticket_type, perks: l.perks }))
  const hold = (token && activeHold(token, e!.id)) || null

  return (
    <>
      <h1>{e!.title}</h1>
      <p className="muted">{e!.venue} · pick seats, or let us find the best available. Tickets are held for a few minutes while you decide.</p>
      <SeatMap eventId={e!.id} ticketLimit={limit} allIn={allIn} qty={qty} sections={sections} levels={levels} seats={seats} initial={getAvailability(e!.id, win)} hold={hold} />
      {resale}
    </>
  )
}
