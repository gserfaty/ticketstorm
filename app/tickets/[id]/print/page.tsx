import QRCode from 'qrcode'
import { notFound } from 'next/navigation'
import PrintButton from '../../../../components/PrintButton.tsx'
import { db } from '../../../../lib/db.ts'
import { fmtDateTimeTz } from '../../../../lib/format.ts'
import { getTicket } from '../../../../lib/orders.ts'
import { makePrintToken } from '../../../../lib/safetix.ts'
import { getSession, getUser, getViewer } from '../../../../lib/session.ts'

export const dynamic = 'force-dynamic'

// Print-at-home ticket: only the owner, only for events that allow printing, only while the ticket is valid. The code is static (see safetix.ts).
export default async function PrintTicket({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id)
  const user = await getUser()
  if ((await getSession())?.impersonator_id) notFound() // the static code is a bearer credential: never shown to an admin viewing as the user
  const t = Number.isInteger(id) && user ? getTicket(id, await getViewer()) : undefined
  if (!t || t.owner_id !== user!.id || t.status !== 'valid' || t.order_status === 'review') notFound()
  const ok = db.prepare('SELECT e.print_ok FROM tickets k LEFT JOIN inventory i ON i.id = k.inventory_id LEFT JOIN addons a ON a.id = k.addon_id JOIN events e ON e.id = coalesce(i.event_id, a.event_id) WHERE k.id = ?').get(id) as { print_ok: number }
  if (!ok.print_ok) notFound()
  const img = await QRCode.toDataURL(makePrintToken(t!.id, t!.secret), { margin: 2, width: 280 })
  return (
    <div className="receipt">
      <h1>{t!.title}</h1>
      <p>{t!.venue} · {fmtDateTimeTz(t!.starts_at, t!.tz)}</p>
      <p><strong>{t!.addon ? `${t!.addon} pass` : t!.row ? `Section ${t!.section} Row ${t!.row} Seat ${t!.number}` : `General admission ${t!.section}`}</strong> · ticket #{t!.id}</p>
      <img src={img} width={280} height={280} alt="Ticket barcode" />
      <p className="muted">Admits one. This printed code does not change: the first scan gets in, so keep the page to yourself. If you transfer or resell this ticket, the printout stops working.</p>
      <PrintButton label="Print this ticket" />
    </div>
  )
}
