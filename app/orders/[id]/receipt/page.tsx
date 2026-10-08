import { notFound } from 'next/navigation'
import PrintButton from '../../../../components/PrintButton.tsx'
import { db } from '../../../../lib/db.ts'
import { fmtDateTime, fmtDateTimeTz, money } from '../../../../lib/format.ts'
import { getOrder } from '../../../../lib/orders.ts'
import { getViewer } from '../../../../lib/session.ts'

export const dynamic = 'force-dynamic'

// Same authorization as the order page (getOrder): owner, or the guest's session / emailed token. "Download PDF" is the browser's print dialog.
export default async function Receipt({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ t?: string }> }) {
  const id = Number((await params).id)
  const o = Number.isInteger(id) ? getOrder(id, await getViewer((await searchParams).t)) : undefined
  if (!o) notFound()
  const lines = db
    .prepare(
      `SELECT oi.kind, oi.unit_cents, oi.fee_cents, oi.tax_cents, s.name AS section, st.row, st.number, a.name AS addon
       FROM order_items oi LEFT JOIN inventory i ON i.id = oi.inventory_id LEFT JOIN sections s ON s.id = i.section_id LEFT JOIN seats st ON st.id = i.seat_id LEFT JOIN addons a ON a.id = oi.addon_id
       WHERE oi.order_id = ? ORDER BY oi.id`,
    )
    .all(id) as { kind: string; unit_cents: number; fee_cents: number; tax_cents: number; section: string | null; row: string | null; number: number | null; addon: string | null }[]
  const pays = db.prepare("SELECT kind, method, amount, status, brand, last4, created_at FROM payments WHERE order_id = ? AND status = 'succeeded' AND method != 'exchange' ORDER BY id").all(id) as { kind: string; method: string; amount: number; brand: string | null; last4: string | null; created_at: string }[]
  const label = (l: (typeof lines)[number]) =>
    l.kind === 'ticket' ? (l.row ? `Ticket · Section ${l.section} Row ${l.row} Seat ${l.number}` : `Ticket · General admission ${l.section}`)
    : l.kind === 'addon' ? `Add-on · ${l.addon}` : l.kind === 'fee' ? 'Order processing and delivery' : l.kind === 'protection' ? 'Ticket protection' : l.kind === 'discount' ? 'Promo discount' : l.kind
  return (
    <div className="receipt">
      <h1>TicketStorm receipt</h1>
      <p>Order #{o!.id} · {fmtDateTime(o!.created_at, o!.tz)} · {o!.email}</p>
      <p><strong>{o!.title}</strong><br />{o!.venue} · {fmtDateTimeTz(o!.starts_at, o!.tz)}</p>
      <table>
        <tbody>
          {lines.map((l, i) => <tr key={i}><td>{label(l)}</td><td>{money(l.unit_cents + l.fee_cents + l.tax_cents)}</td></tr>)}
          <tr><td><strong>Total</strong></td><td><strong>{money(o!.total)}</strong></td></tr>
        </tbody>
      </table>
      <p className="muted">Includes {money(o!.fees)} in fees and {money(o!.tax)} in tax.</p>
      <h2>Payments</h2>
      <ul>{pays.map((p, i) => <li key={i}>{p.kind === 'refund' ? 'Refund' : 'Payment'} {money(p.amount)} · {p.method}{p.last4 ? ` ${p.brand} ····${p.last4}` : ''} · {fmtDateTime(p.created_at, o!.tz)}</li>)}</ul>
      <PrintButton />
    </div>
  )
}
