import Link from 'next/link'
import Flash from '../../../components/Flash.tsx'
import { db } from '../../../lib/db.ts'
import { money } from '../../../lib/format.ts'
import { requireAdmin } from '../../../lib/session.ts'
import { claimDecision } from '../actions.ts'

export const dynamic = 'force-dynamic'

export default async function Claims({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  await requireAdmin()
  const rows = db
    .prepare(
      `SELECT c.id, c.order_id, c.reason, c.details, c.status, c.created_at, o.email, o.total, o.protection, e.title
       FROM claims c JOIN orders o ON o.id = c.order_id JOIN events e ON e.id = o.event_id ORDER BY c.status != 'submitted', c.id DESC LIMIT 100`,
    )
    .all() as { id: number; order_id: number; reason: string; details: string | null; status: string; email: string; total: number; protection: number; title: string }[]
  return (
    <>
      <h1>Protection claims</h1>
      <p className="muted">Approving refunds the order except the protection premium and cancels its tickets. The seats stay sold.</p>
      <Flash {...(await searchParams)} />
      {rows.map((c) => (
        <div className="card" key={c.id}>
          Claim #{c.id} on <Link href={`/orders/${c.order_id}`}>order #{c.order_id}</Link> · {c.email} · {c.title} · {money(c.total - c.protection)} refundable · <span className="badge">{c.status}</span>
          <div>{c.reason}{c.details ? `: ${c.details}` : ''}</div>
          {c.status === 'submitted' && (
            <form action={claimDecision} className="row">
              <input type="hidden" name="claimId" value={c.id} />
              <button name="decision" value="approve">Approve</button>
              <button name="decision" value="deny">Deny</button>
            </form>
          )}
        </div>
      ))}
      {!rows.length && <p>No claims.</p>}
    </>
  )
}
