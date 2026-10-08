import Link from 'next/link'
import { notFound } from 'next/navigation'
import { db } from '../../../lib/db.ts'
import { fmtDateTimeTz, money } from '../../../lib/format.ts'
import { getTicket } from '../../../lib/orders.ts'
import { getUser, getViewer } from '../../../lib/session.ts'
import TicketQR from '../../../components/TicketQR.tsx'
import { cancelListingAction, sellTicket } from '../../resale/actions.ts'
import { cancelTransferAction, sendTransfer } from '../../transfers/actions.ts'

export const dynamic = 'force-dynamic'

export default async function Ticket({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ t?: string; error?: string; notice?: string }> }) {
  const id = Number((await params).id)
  const { t: tok, error, notice } = await searchParams
  const t = Number.isInteger(id) ? getTicket(id, await getViewer(tok)) : undefined
  if (!t) notFound()
  const user = await getUser()
  const mine = !!user && t!.owner_id === user.id
  const now = new Date().toISOString()
  // controls only for the owner, only while the ticket is live and the show is ahead; the server re-checks every action
  const open = mine && t!.starts_at > now && !t!.addon // passes can't be transferred or resold
  const pending = open ? (db.prepare("SELECT id, to_email, to_phone FROM transfers WHERE ticket_id = ? AND status = 'pending' AND expires_at > ?").get(id, now) as { id: number; to_email: string | null; to_phone: string | null } | undefined) : undefined
  const listing = open ? (db.prepare("SELECT id, price_cents FROM listings WHERE ticket_id = ? AND status = 'active'").get(id) as { id: number; price_cents: number } | undefined) : undefined
  return (
    <>
      <h1>{t!.title}</h1>
      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}
      <p>{t!.venue} · {fmtDateTimeTz(t!.starts_at, t!.tz)}</p>
      <p>{t!.addon ? `${t!.addon} pass` : t!.row ? `Section ${t!.section} Row ${t!.row} Seat ${t!.number}` : `General admission ${t!.section}`} · <span className="badge">{t!.status}</span></p>
      {t!.status === 'valid' ? <TicketQR ticketId={t!.id} secret={t!.secret} /> : <p>This ticket is {t!.status} and cannot be scanned.</p>}
      {open && t!.status === 'valid' && pending && (
        <div className="card">
          Pending transfer to {pending.to_email ?? pending.to_phone}. <Link href={`/transfers/${pending.id}`}>Details</Link>
          <form action={cancelTransferAction}>
            <input type="hidden" name="transferId" value={pending.id} />
            <input type="hidden" name="back" value={`/tickets/${id}`} />
            <button>Cancel transfer</button>
          </form>
        </div>
      )}
      {open && t!.status === 'valid' && !pending && (
        <div className="card">
          <form action={sendTransfer} className="stack">
            <input type="hidden" name="ticketId" value={id} />
            <label>Send to (email or phone) <input name="to" required /></label>
            <button>Transfer ticket</button>
          </form>
          <form action={sellTicket} className="stack">
            <input type="hidden" name="ticketId" value={id} />
            <label>Sell for $ <input name="price" inputMode="decimal" required pattern="\d{1,6}(\.\d{1,2})?" size={8} /></label>
            <button>List for resale</button>
          </form>
        </div>
      )}
      {open && t!.status === 'listed' && listing && (
        <div className="card">
          Listed for resale at {money(listing.price_cents)}.
          <form action={cancelListingAction}>
            <input type="hidden" name="listingId" value={listing.id} />
            <button>Cancel listing</button>
          </form>
        </div>
      )}
      {(t!.owner_id === t!.user_id || t!.owner_id === null) && <p><Link href={`/orders/${t!.order_id}${tok ? `?t=${encodeURIComponent(tok)}` : ''}`}>Order #{t!.order_id}</Link></p>}
    </>
  )
}
