import Link from 'next/link'
import { notFound } from 'next/navigation'
import Flash from '../../../components/Flash.tsx'
import { db } from '../../../lib/db.ts'
import { fmtDateTime, fmtDateTimeTz, money } from '../../../lib/format.ts'
import { getOrder, heldByBuyer } from '../../../lib/orders.ts'
import { CLAIM_REASONS } from '../../../lib/protection.ts'
import { ticketState } from '../../../lib/ticketstate.ts'
import { getViewer } from '../../../lib/session.ts'
import { fileClaim, requestRefund, resendConfirmation } from '../actions.ts'

export const dynamic = 'force-dynamic'

type Pay = { id: number; kind: string; method: string; amount: number; status: string; brand: string | null; last4: string | null; due_at: string | null; decline_code: string | null; created_at: string }

export default async function Order({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ t?: string; error?: string; notice?: string }> }) {
  const id = Number((await params).id)
  const { t, error, notice } = await searchParams
  const o = Number.isInteger(id) ? getOrder(id, await getViewer(t)) : undefined
  if (!o) notFound()
  const items = db
    .prepare(
      `SELECT oi.unit_cents, oi.fee_cents, oi.tax_cents, oi.refunded_cents, tk.id AS ticket_id, tk.status, s.name AS section, st.row, st.number
       FROM order_items oi JOIN inventory i ON i.id = oi.inventory_id JOIN sections s ON s.id = i.section_id LEFT JOIN seats st ON st.id = i.seat_id
       JOIN tickets tk ON tk.id = (SELECT max(id) FROM tickets WHERE order_id = oi.order_id AND inventory_id = oi.inventory_id) WHERE oi.order_id = ? ORDER BY oi.id`,
    )
    .all(id) as { unit_cents: number; fee_cents: number; tax_cents: number; refunded_cents: number; ticket_id: number; status: string; section: string; row: string | null; number: number | null }[]
  const addons = db
    .prepare("SELECT a.name, count(*) AS n, sum(oi.unit_cents) AS total FROM order_items oi JOIN addons a ON a.id = oi.addon_id WHERE oi.order_id = ? AND oi.kind = 'addon' GROUP BY a.id ORDER BY a.id")
    .all(id) as { name: string; n: number; total: number }[]
  const passes = db.prepare('SELECT t.id, t.status, a.name FROM tickets t JOIN addons a ON a.id = t.addon_id WHERE t.order_id = ? ORDER BY t.id').all(id) as { id: number; status: string; name: string }[]
  const promo = o!.discount > 0 ? (db.prepare('SELECT p.code FROM orders o JOIN promo_codes p ON p.id = o.promo_id WHERE o.id = ?').get(id) as { code: string } | undefined)?.code : undefined
  const orderFee = (db.prepare("SELECT coalesce(sum(fee_cents), 0) AS f FROM order_items WHERE order_id = ? AND kind = 'fee'").get(id) as { f: number }).f
  const pays = db.prepare("SELECT id, kind, method, amount, status, brand, last4, due_at, decline_code, created_at FROM payments WHERE order_id = ? AND method != 'exchange' ORDER BY id").all(id) as Pay[]
  const paid = pays.filter((p) => p.kind === 'charge' && p.status === 'succeeded').reduce((n, p) => n + p.amount, 0)
  const refunded = pays.filter((p) => p.kind === 'refund' && p.status === 'succeeded').reduce((n, p) => n + p.amount, 0)
  const ev = db.prepare('SELECT status, refund_window_until FROM events WHERE id = ?').get(o!.event_id) as { status: string; refund_window_until: string | null }
  const claim = db.prepare('SELECT id, reason, status FROM claims WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(id) as { id: number; reason: string; status: string } | undefined
  const now = new Date().toISOString()
  const active = ['paid', 'partially_refunded'].includes(o!.status)
  const canRefund = active && ev.status === 'rescheduled' && !!ev.refund_window_until && ev.refund_window_until > now && heldByBuyer(id) && !items.some((i) => i.status === 'used')
  const canClaim = active && o!.protection > 0 && (!claim || claim.status === 'denied') && heldByBuyer(id)
  const suffix = t ? `?t=${encodeURIComponent(t)}` : ''
  const hidden = <><input type="hidden" name="orderId" value={id} />{t && <input type="hidden" name="t" value={t} />}</>
  return (
    <>
      <h1>Order #{o!.id} {o!.status === 'paid' ? 'confirmed' : o!.status.replace('_', ' ')}</h1>
      <Flash error={error} notice={notice} />
      <p><Link href={`/events/${o!.slug}`}>{o!.title}</Link> · {o!.venue} · {fmtDateTimeTz(o!.starts_at, o!.tz)}</p>
      <p className="muted">Status: {o!.status.replace('_', ' ')}. Confirmation sent to {o!.email}.</p>
      {o!.status === 'review' && <p className="notice">This order is under review. Your tickets are on hold and cannot be scanned or transferred until it is approved.</p>}
      {o!.refund_error && <p className="error">Your refund could not be completed yet (the card refused it). We are retrying; you do not need to do anything.</p>}
      <div className="row">
        <Link className="btn" href={`/orders/${id}/receipt${suffix}`}>Receipt</Link>
        <form action={resendConfirmation}>{hidden}<button>Resend confirmation</button></form>
      </div>
      <div className="card">
        <ul>
          {items.map((i) => (
            <li key={i.ticket_id}>
              {i.row ? `Section ${i.section} Row ${i.row} Seat ${i.number}` : `General admission ${i.section}`} · {money(i.unit_cents)} + {money(i.fee_cents)} fees + {money(i.tax_cents)} tax · <span className="badge">{ticketState(i.status, o!.status, o!.starts_at)}</span>
              {i.refunded_cents > 0 && ` · refunded ${money(i.refunded_cents)}`}{' '}
              <Link href={`/tickets/${i.ticket_id}${suffix}`}>View ticket</Link>
            </li>
          ))}
          {addons.map((a) => <li key={a.name}>{a.n} × {a.name} · {money(a.total)}</li>)}
          {passes.map((p) => <li key={p.id}>{p.name} pass · <span className="badge">{ticketState(p.status, o!.status, o!.starts_at)}</span> <Link href={`/tickets/${p.id}${suffix}`}>View pass</Link></li>)}
          {orderFee > 0 && <li>Order processing and delivery fees · {money(orderFee)}</li>}
        </ul>
        <table>
          <tbody>
            <tr><td>Tickets{addons.length ? ' and add-ons' : ''}</td><td>{money(o!.subtotal)}</td></tr>
            <tr><td>Fees</td><td>{money(o!.fees)}</td></tr>
            <tr><td>Tax</td><td>{money(o!.tax)}</td></tr>
            {o!.discount > 0 && <tr><td>Promo {promo}</td><td>-{money(o!.discount)}</td></tr>}
            {o!.protection > 0 && <tr><td>Ticket protection</td><td>{money(o!.protection)}</td></tr>}
            <tr><td><strong>Total</strong></td><td><strong>{money(o!.total)}</strong></td></tr>
          </tbody>
        </table>
      </div>

      <h2>Payments and refunds</h2>
      <div className="card">
        <ul>
          {pays.map((p) => (
            <li key={p.id}>
              {p.kind === 'refund' ? 'Refund' : 'Payment'} {money(p.amount)} · {p.method}{p.last4 ? ` ${p.brand} ····${p.last4}` : ''} · {p.status === 'pending' && p.due_at ? `due ${fmtDateTime(p.due_at, o!.tz)}` : p.status}{p.decline_code ? ` (${p.decline_code})` : ''}
            </li>
          ))}
        </ul>
        <p>Paid {money(paid)}{refunded > 0 && ` · refunded ${money(refunded)} (${refunded >= paid ? 'in full' : 'partly'})`}</p>
        {canRefund && (
          <form action={requestRefund}>
            {hidden}
            <p>This event was rescheduled. You can get a full refund until {fmtDateTime(ev.refund_window_until!, o!.tz)}.</p>
            <button>Refund this order</button>
          </form>
        )}
        {active && ev.status === 'rescheduled' && !canRefund && <p className="muted">The refund window for the new date has closed or does not apply to this order.</p>}
      </div>

      {o!.protection > 0 && (
        <>
          <h2>Ticket protection</h2>
          <div className="card">
            {claim && <p>Claim ({claim.reason}): <strong>{claim.status}</strong></p>}
            {canClaim && (
              <form action={fileClaim} className="stack">
                {hidden}
                <label>Reason <select name="reason">{CLAIM_REASONS.map((r) => <option key={r}>{r}</option>)}</select></label>
                <textarea name="details" rows={3} maxLength={1000} placeholder="Tell us what happened" />
                <button>File a claim</button>
              </form>
            )}
          </div>
        </>
      )}
    </>
  )
}
