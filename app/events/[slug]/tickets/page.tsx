import { notFound, redirect } from 'next/navigation'
import { db } from '../../../../lib/db.ts'
import { eventState, getEvent } from '../../../../lib/events.ts'
import { activeHold, getAvailability, isSoldOut } from '../../../../lib/inventory.ts'
import { getSession } from '../../../../lib/session.ts'
import SeatMap from '../../../../components/SeatMap.tsx'
import type { MapSeat, MapSection } from '../../../../components/SeatMap.tsx'

export const dynamic = 'force-dynamic'

export default async function Tickets({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ qty?: string }> }) {
  const { slug } = await params
  const e = getEvent(slug)
  if (!e) notFound()
  if (!eventState(e!).canBuy) redirect(`/events/${slug}`)
  const qty = Math.min(Math.max(parseInt((await searchParams).qty ?? '', 10) || 2, 1), e!.ticket_limit)
  if (isSoldOut(e!.id)) return <><h1>{e!.title}</h1><p><strong>Sold out.</strong></p></>

  const sections = (
    db
      .prepare('SELECT s.id, s.name, s.kind, s.path, s.label_x AS lx, s.label_y AS ly FROM sections s JOIN events ev ON ev.venue_id = s.venue_id WHERE ev.id = ? ORDER BY s.rank, s.id')
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
  const levels = e!.levels.map((l) => ({ id: l.id, name: l.name, color: l.color, cents: l.price_cents, type: l.ticket_type }))
  const token = (await getSession())?.token
  const hold = (token && activeHold(token, e!.id)) || null

  return (
    <>
      <h1>{e!.title}</h1>
      <p className="muted">{e!.venue} · pick seats, or let us find the best available. Tickets are held for a few minutes while you decide.</p>
      <SeatMap eventId={e!.id} ticketLimit={e!.ticket_limit} qty={qty} sections={sections} levels={levels} seats={seats} initial={getAvailability(e!.id)} hold={hold} />
    </>
  )
}
