import Flash from '../../../components/Flash.tsx'
import { db } from '../../../lib/db.ts'
import { money } from '../../../lib/format.ts'
import { requireAdmin } from '../../../lib/session.ts'
import { fmtDateTime } from '../../../lib/format.ts'
import { retryRefunds } from '../actions.ts'

export const dynamic = 'force-dynamic'

export default async function Refunds({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  await requireAdmin()
  const rows = db
    .prepare('SELECT o.id, o.email, o.total, o.event_id, e.title FROM orders o JOIN events e ON e.id = o.event_id WHERE o.refund_error IS NOT NULL ORDER BY o.id')
    .all() as { id: number; email: string; total: number; event_id: number; title: string }[]
  const log = db
    .prepare(
      `SELECT p.id, p.order_id, p.amount, p.status, p.method, p.created_at, o.email, o.status AS order_status FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE p.kind = 'refund' ORDER BY p.id DESC LIMIT 100`,
    )
    .all() as { id: number; order_id: number; amount: number; status: string; method: string; created_at: string; email: string; order_status: string }[]
  return (
    <>
      <h1>Failed refunds</h1>
      <p className="muted">Orders from cancelled events whose card refused the refund. They stay &quot;cancelled&quot; (not refunded) until a retry succeeds.</p>
      <Flash {...(await searchParams)} />
      {rows.map((r) => (
        <div className="card" key={r.id}>
          Order #{r.id} · {r.email} · {money(r.total)} · {r.title}
          <form action={retryRefunds} className="buy"><input type="hidden" name="eventId" value={r.event_id} /><button>Retry this event&apos;s refunds</button></form>
        </div>
      ))}
      {!rows.length && <p>None.</p>}
      <h2>Refund oversight</h2>
      <p className="muted">The 100 most recent refund payments across all orders.</p>
      <table>
        <tbody>
          {log.map((p) => <tr key={p.id}><td>{fmtDateTime(p.created_at, 'UTC')}</td><td>order #{p.order_id} ({p.order_status})</td><td>{p.email}</td><td>{money(p.amount)}</td><td>{p.method}</td><td>{p.status}</td></tr>)}
        </tbody>
      </table>
    </>
  )
}
