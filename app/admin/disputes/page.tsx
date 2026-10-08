import Link from 'next/link'
import Flash from '../../../components/Flash.tsx'
import { db } from '../../../lib/db.ts'
import { money } from '../../../lib/format.ts'
import { requireAdmin } from '../../../lib/session.ts'
import { disputeDecision } from '../actions.ts'

export const dynamic = 'force-dynamic'

export default async function Disputes({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  await requireAdmin()
  const rows = db
    .prepare(
      `SELECT d.id, d.order_id, d.amount, d.reason, d.status, d.note, d.created_at, o.email, o.status AS order_status, e.title FROM disputes d JOIN orders o ON o.id = d.order_id JOIN events e ON e.id = o.event_id
       ORDER BY d.status != 'open', d.id DESC LIMIT 100`,
    )
    .all() as { id: number; order_id: number; amount: number; reason: string; status: string; note: string | null; email: string; order_status: string; title: string }[]
  return (
    <>
      <h1>Chargebacks</h1>
      <p className="muted">The 0341 test card charges fine, then the bank disputes it. <strong>Won</strong>: the charge stands. <strong>Lost</strong>: the card part is taken back (a refund payment that cannot fail), the tickets are cancelled and the seats go back on sale; gift card and credit paid on the order return to their balances.</p>
      <Flash {...(await searchParams)} />
      {rows.map((d) => (
        <div className="card" key={d.id}>
          Dispute #{d.id} on <Link href={`/orders/${d.order_id}`}>order #{d.order_id}</Link> · {d.email} · {d.title} · {money(d.amount)} · order {d.order_status} · <span className="badge">{d.status}</span>
          <div className="muted">{d.reason}{d.note ? ` · note: ${d.note}` : ''}</div>
          {d.status === 'open' && (
            <form action={disputeDecision} className="row">
              <input type="hidden" name="disputeId" value={d.id} />
              <input name="note" placeholder="Note (optional)" maxLength={500} aria-label="Note" />
              <button name="outcome" value="won">Won (charge stands)</button>
              <button name="outcome" value="lost">Lost (refund the bank)</button>
            </form>
          )}
        </div>
      ))}
      {!rows.length && <p>No disputes.</p>}
    </>
  )
}
