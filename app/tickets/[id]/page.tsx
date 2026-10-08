import Link from 'next/link'
import { notFound } from 'next/navigation'
import { db } from '../../../lib/db.ts'
import { fmtDateTimeTz, money } from '../../../lib/format.ts'
import { getTicket } from '../../../lib/orders.ts'
import { getUser, getViewer } from '../../../lib/session.ts'
import { priceBounds } from '../../../lib/resale.ts'
import { transferCloses, transferRule } from '../../../lib/rules.ts'
import { ticketState } from '../../../lib/ticketstate.ts'
import TicketQR from '../../../components/TicketQR.tsx'
import { cancelListingAction, editListingAction, sellTicket } from '../../resale/actions.ts'
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
  const ev = db.prepare('SELECT coalesce(i.event_id, a.event_id) AS event_id FROM tickets k LEFT JOIN inventory i ON i.id = k.inventory_id LEFT JOIN addons a ON a.id = k.addon_id WHERE k.id = ?').get(id) as { event_id: number | null }
  const flags = (ev.event_id ? db.prepare('SELECT print_ok, willcall_ok, non_transferable FROM events WHERE id = ?').get(ev.event_id) : undefined) as { print_ok: number; willcall_ok: number; non_transferable: number } | undefined
  const delivery = (db.prepare('SELECT delivery, picked_up_at FROM orders WHERE id = ?').get(t!.order_id) as { delivery: string; picked_up_at: string | null })
  const rule = ev.event_id ? transferRule(ev.event_id) : undefined
  const closes = ev.event_id ? transferCloses(ev.event_id, t!.starts_at) : null
  const transferOpen = !!rule?.enabled && (!closes || closes > now)
  const bounds = ev.event_id && open ? priceBounds(id, ev.event_id) : undefined
  return (
    <>
      <h1>{t!.title}</h1>
      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}
      <p>{t!.venue} · {fmtDateTimeTz(t!.starts_at, t!.tz)}</p>
      <p>{t!.addon ? `${t!.addon} pass` : t!.row ? `Section ${t!.section} Row ${t!.row} Seat ${t!.number}` : `General admission ${t!.section}`} · <span className="badge">{ticketState(t!.status, t!.order_status, t!.starts_at, !!pending)}</span></p>
      {mine && <p className="muted"><a href={`/api/tickets/${id}/pass?wallet=apple`}>Add to Apple Wallet</a> · <a href={`/api/tickets/${id}/pass?wallet=google`}>Add to Google Wallet</a> (simulated passes)</p>}
      {delivery.delivery === 'willcall' && <p className="notice">Will-call: {delivery.picked_up_at ? `picked up at the box office on ${fmtDateTimeTz(delivery.picked_up_at, t!.tz)}.` : `pick up your tickets at the box office with photo ID and order #${t!.order_id}. The mobile code below works too.`}</p>}
      {mine && t!.status === 'valid' && t!.order_status !== 'review' && (flags?.print_ok ? <p><Link href={`/tickets/${id}/print`}>Print this ticket</Link> <span className="muted">(static barcode, first scan wins)</span></p> : <p className="muted">Mobile tickets only for this event: printouts are not accepted.</p>)}
      {t!.order_status === 'review' && <p className="notice">This order is under review. The ticket cannot be scanned or transferred until it is approved.</p>}
      {t!.status === 'valid' && t!.order_status !== 'review' ? <TicketQR ticketId={t!.id} secret={t!.secret} /> : t!.status !== 'valid' && <p>This ticket is {t!.status} and cannot be scanned.</p>}
      {open && t!.status === 'valid' && ['paid', 'partially_refunded'].includes(t!.order_status) && !t!.addon && <p><Link href={`/tickets/${id}/exchange`}>Exchange for another date</Link></p>}
      {open && t!.status === 'valid' && pending && (
        <div className="card">
          Pending transfer to {pending.to_email ?? pending.to_phone}. <Link href={`/transfers/${pending.id}`}>Details</Link>
          <form action={cancelTransferAction}>
            <input type="hidden" name="transferId" value={pending.id} />
            <input type="hidden" name="back" value={`/tickets/${id}`} />
            <button>Reclaim ticket (cancel transfer)</button>
          </form>
        </div>
      )}
      {open && t!.status === 'valid' && !pending && flags?.non_transferable && <p className="card">The organizer made these tickets <strong>non-transferable</strong>: they cannot be sent to someone else or resold.</p>}
      {open && t!.status === 'valid' && !pending && !flags?.non_transferable && (
        <div className="card">
          {transferOpen ? (
            <form action={sendTransfer} className="stack">
              <input type="hidden" name="ticketId" value={id} />
              <label>Send to (email or phone) <input name="to" required /></label>
              <button>Transfer ticket</button>
              {rule?.deadline_hours && <span className="muted">Transfers close {rule.deadline_hours} hours before the show.</span>}
            </form>
          ) : <p className="muted">{rule?.enabled ? `Transfers for this event closed ${rule.deadline_hours} hours before the show.` : 'The organizer has turned off transfers for this event.'}</p>}
          <form action={sellTicket} className="stack">
            <input type="hidden" name="ticketId" value={id} />
            <label>Sell for $ <input name="price" inputMode="decimal" required pattern="\d{1,6}(\.\d{1,2})?" size={8} /></label>
            <button>List for resale</button>
            <span className="muted">{!bounds?.rule.enabled ? 'Resale is turned off for this event.' : bounds.face <= 0 ? 'Complimentary tickets cannot be resold.' : `Allowed ${money(bounds.min)} to ${money(bounds.max)} (face ${money(bounds.face)}); seller fee ${bounds.rule.seller_fee_pct}%.`}</span>
          </form>
        </div>
      )}
      {open && t!.status === 'listed' && listing && (
        <div className="card">
          Listed for resale at {money(listing.price_cents)}.
          <form action={editListingAction} className="row">
            <input type="hidden" name="listingId" value={listing.id} />
            <label>New price $ <input name="price" inputMode="decimal" required pattern="\d{1,6}(\.\d{1,2})?" size={8} defaultValue={(listing.price_cents / 100).toFixed(2)} /></label> <button>Change price</button>
          </form>
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
