import Link from 'next/link'
import { notFound } from 'next/navigation'
import { fmtDateTimeTz } from '../../../lib/format.ts'
import { getTicket } from '../../../lib/orders.ts'
import { getViewer } from '../../../lib/session.ts'
import TicketQR from '../../../components/TicketQR.tsx'

export const dynamic = 'force-dynamic'

export default async function Ticket({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ t?: string }> }) {
  const id = Number((await params).id)
  const t = Number.isInteger(id) ? getTicket(id, await getViewer((await searchParams).t)) : undefined
  if (!t) notFound()
  return (
    <>
      <h1>{t!.title}</h1>
      <p>{t!.venue} · {fmtDateTimeTz(t!.starts_at, t!.tz)}</p>
      <p>{t!.row ? `Section ${t!.section} Row ${t!.row} Seat ${t!.number}` : `General admission ${t!.section}`} · <span className="badge">{t!.status}</span></p>
      {t!.status === 'valid' ? <TicketQR ticketId={t!.id} secret={t!.secret} /> : <p>This ticket is {t!.status} and cannot be scanned.</p>}
      <p><Link href={`/orders/${t!.order_id}`}>Order #{t!.order_id}</Link></p>
    </>
  )
}
