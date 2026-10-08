import Flash from '../../../components/Flash.tsx'
import { db } from '../../../lib/db.ts'
import { money } from '../../../lib/format.ts'
import { requireAdmin } from '../../../lib/session.ts'
import { retryRefunds } from '../actions.ts'

export const dynamic = 'force-dynamic'

export default async function Refunds({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  await requireAdmin()
  const rows = db
    .prepare('SELECT o.id, o.email, o.total, o.event_id, e.title FROM orders o JOIN events e ON e.id = o.event_id WHERE o.refund_error IS NOT NULL ORDER BY o.id')
    .all() as { id: number; email: string; total: number; event_id: number; title: string }[]
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
    </>
  )
}
