import { notFound, redirect } from 'next/navigation'
import { eventState, getEvent } from '../../../../lib/events.ts'

// Placeholder: the seat map and holds arrive in P3.
export default async function Tickets({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ qty?: string }> }) {
  const { slug } = await params
  const e = getEvent(slug)
  if (!e) notFound()
  if (!eventState(e!).canBuy) redirect(`/events/${slug}`)
  const qty = Math.min(Math.max(parseInt((await searchParams).qty ?? '', 10) || 2, 1), e!.ticket_limit)
  return (
    <>
      <h1>{e!.title}</h1>
      <p>Looking for {qty} ticket{qty === 1 ? '' : 's'}. Seat selection is coming soon.</p>
    </>
  )
}
