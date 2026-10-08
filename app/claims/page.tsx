import Link from 'next/link'
import { db } from '../../lib/db.ts'
import { fmtDateTime, money } from '../../lib/format.ts'
import { requireUser } from '../../lib/session.ts'

export const dynamic = 'force-dynamic'

const NOTE: Record<string, string> = {
  submitted: 'Received. A team member is reviewing it; we email you when it is decided.',
  approved: 'Approved: the order was refunded (the protection premium is not returned).',
  denied: 'Denied. You can file another claim from the order page if you have new details.',
}

// Claim status for the logged-in user's own orders only.
export default async function Claims() {
  const user = await requireUser()
  const rows = db
    .prepare(
      `SELECT c.id, c.order_id, c.reason, c.status, c.created_at, c.decided_at, o.total, o.protection, e.title FROM claims c JOIN orders o ON o.id = c.order_id JOIN events e ON e.id = o.event_id
       WHERE o.user_id = ? ORDER BY c.id DESC`,
    )
    .all(user.id) as { id: number; order_id: number; reason: string; status: string; created_at: string; decided_at: string | null; total: number; protection: number; title: string }[]
  return (
    <>
      <h1>Your protection claims</h1>
      {rows.map((c) => (
        <div className="card" key={c.id}>
          Claim #{c.id} · <Link href={`/orders/${c.order_id}`}>order #{c.order_id}</Link> · {c.title} · {c.reason} · <span className="badge">{c.status}</span>
          <div className="muted">Filed {fmtDateTime(c.created_at, 'UTC')} UTC{c.decided_at ? `, decided ${fmtDateTime(c.decided_at, 'UTC')} UTC` : ''}. {NOTE[c.status]} {c.status === 'approved' && `Refund ${money(c.total - c.protection)}.`}</div>
        </div>
      ))}
      {!rows.length && <p>No claims. You can file one from an order that has ticket protection.</p>}
    </>
  )
}
