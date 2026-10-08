import Link from 'next/link'
import { notFound } from 'next/navigation'
import { db } from '../../../lib/db.ts'
import { fmtDateTimeTz, money } from '../../../lib/format.ts'
import { getOrder } from '../../../lib/orders.ts'
import { getViewer } from '../../../lib/session.ts'

export const dynamic = 'force-dynamic'

export default async function Order({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ t?: string }> }) {
  const id = Number((await params).id)
  const t = (await searchParams).t
  const o = Number.isInteger(id) ? getOrder(id, await getViewer(t)) : undefined
  if (!o) notFound()
  const items = db
    .prepare(
      `SELECT oi.unit_cents, oi.fee_cents, oi.tax_cents, tk.id AS ticket_id, tk.status, s.name AS section, st.row, st.number
       FROM order_items oi JOIN inventory i ON i.id = oi.inventory_id JOIN sections s ON s.id = i.section_id LEFT JOIN seats st ON st.id = i.seat_id
       JOIN tickets tk ON tk.id = (SELECT min(id) FROM tickets WHERE order_id = oi.order_id AND inventory_id = oi.inventory_id) WHERE oi.order_id = ? ORDER BY oi.id`,
    )
    .all(id) as { unit_cents: number; fee_cents: number; tax_cents: number; ticket_id: number; status: string; section: string; row: string | null; number: number | null }[]
  const addons = db
    .prepare("SELECT a.name, count(*) AS n, sum(oi.unit_cents) AS total FROM order_items oi JOIN addons a ON a.id = oi.addon_id WHERE oi.order_id = ? AND oi.kind = 'addon' GROUP BY a.id ORDER BY a.id")
    .all(id) as { name: string; n: number; total: number }[]
  const passes = db.prepare('SELECT t.id, t.status, a.name FROM tickets t JOIN addons a ON a.id = t.addon_id WHERE t.order_id = ? ORDER BY t.id').all(id) as { id: number; status: string; name: string }[]
  const promo = o!.discount > 0 ? (db.prepare('SELECT p.code FROM orders o JOIN promo_codes p ON p.id = o.promo_id WHERE o.id = ?').get(id) as { code: string } | undefined)?.code : undefined
  const orderFee = (db.prepare("SELECT coalesce(sum(fee_cents), 0) AS f FROM order_items WHERE order_id = ? AND kind = 'fee'").get(id) as { f: number }).f
  const suffix = t ? `?t=${encodeURIComponent(t)}` : ''
  return (
    <>
      <h1>Order #{o!.id} {o!.status === 'paid' ? 'confirmed' : o!.status}</h1>
      <p><Link href={`/events/${o!.slug}`}>{o!.title}</Link> · {o!.venue} · {fmtDateTimeTz(o!.starts_at, o!.tz)}</p>
      <p className="muted">Status: {o!.status}. Confirmation sent to {o!.email}.</p>
      <div className="card">
        <ul>
          {items.map((i) => (
            <li key={i.ticket_id}>
              {i.row ? `Section ${i.section} Row ${i.row} Seat ${i.number}` : `General admission ${i.section}`} · {money(i.unit_cents)} + {money(i.fee_cents)} fees + {money(i.tax_cents)} tax · {i.status}{' '}
              <Link href={`/tickets/${i.ticket_id}${suffix}`}>View ticket</Link>
            </li>
          ))}
          {addons.map((a) => <li key={a.name}>{a.n} × {a.name} · {money(a.total)}</li>)}
          {passes.map((p) => <li key={p.id}>{p.name} pass · {p.status} <Link href={`/tickets/${p.id}${suffix}`}>View pass</Link></li>)}
          {orderFee > 0 && <li>Order processing and delivery fees · {money(orderFee)}</li>}
        </ul>
        <table>
          <tbody>
            <tr><td>Tickets{addons.length ? ' and add-ons' : ''}</td><td>{money(o!.subtotal)}</td></tr>
            <tr><td>Fees</td><td>{money(o!.fees)}</td></tr>
            <tr><td>Tax</td><td>{money(o!.tax)}</td></tr>
            {o!.discount > 0 && <tr><td>Promo {promo}</td><td>-{money(o!.discount)}</td></tr>}
            <tr><td><strong>Total</strong></td><td><strong>{money(o!.total)}</strong></td></tr>
          </tbody>
        </table>
      </div>
    </>
  )
}
