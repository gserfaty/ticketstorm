import Flash from '../../../components/Flash.tsx'
import { db } from '../../../lib/db.ts'
import { money } from '../../../lib/format.ts'
import { requireAdmin } from '../../../lib/session.ts'
import { reviewApprove, reviewCancel } from '../actions.ts'

export const dynamic = 'force-dynamic'

export default async function Review({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  await requireAdmin()
  const rows = db
    .prepare(
      `SELECT o.id, o.email, o.total, o.fraud_score, o.review_reason, o.created_at, e.title FROM orders o JOIN events e ON e.id = o.event_id
       WHERE o.status = 'review' ORDER BY o.id`,
    )
    .all() as { id: number; email: string; total: number; fraud_score: number | null; review_reason: string | null; title: string }[]
  return (
    <>
      <h1>Orders in review</h1>
      <p className="muted">Held by the fraud score (new account, high value, billing city mismatch, random check), by an organizer, or because an installment failed. The tickets cannot be scanned, sent or sold until you approve. Cancelling refunds what was paid and puts the seats back on sale.</p>
      <Flash {...(await searchParams)} />
      {rows.map((o) => (
        <div className="card" key={o.id}>
          Order #{o.id} · {o.email} · {money(o.total)} · {o.title}
          <div className="muted">Score {o.fraud_score ?? '-'} · {o.review_reason}</div>
          <div className="row">
            <form action={reviewApprove}><input type="hidden" name="orderId" value={o.id} /><button>Approve</button></form>
            <form action={reviewCancel}><input type="hidden" name="orderId" value={o.id} /><button>Cancel and refund</button></form>
          </div>
        </div>
      ))}
      {!rows.length && <p>Nothing to review.</p>}
    </>
  )
}
