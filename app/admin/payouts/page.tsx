import Flash from '../../../components/Flash.tsx'
import { db } from '../../../lib/db.ts'
import { fmtDateTime, money } from '../../../lib/format.ts'
import { ledgerTotal } from '../../../lib/ledger.ts'
import { requireAdmin } from '../../../lib/session.ts'
import { payoutDecision } from '../actions.ts'

export const dynamic = 'force-dynamic'

export default async function AdminPayouts({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  await requireAdmin()
  const rows = db
    .prepare(
      `SELECT p.id, p.account, p.amount, p.status, p.created_at, u.email, o.name AS org FROM payouts p JOIN users u ON u.id = p.requested_by
       LEFT JOIN orgs o ON p.account = 'org:' || o.id ORDER BY (p.status = 'requested') DESC, p.id DESC LIMIT 100`,
    )
    .all() as { id: number; account: string; amount: number; status: string; created_at: string; email: string; org: string | null }[]
  return (
    <>
      <h1>Payouts</h1>
      <p className="muted">Ledger check: all accounts sum to {money(ledgerTotal())} (must be $0.00). Mark paid after sending the money (simulated); reject returns it to the balance.</p>
      <Flash {...(await searchParams)} />
      {rows.map((p) => (
        <div className="card" key={p.id}>
          #{p.id} · {p.org ? `Org ${p.org}` : p.account} · requested by {p.email} · {money(p.amount)} · <span className="badge">{p.status}</span> <span className="muted">{fmtDateTime(p.created_at, 'UTC')} UTC</span>
          {p.status === 'requested' && (
            <form action={payoutDecision} className="row">
              <input type="hidden" name="payoutId" value={p.id} />
              <button name="decision" value="paid">Mark paid</button>
              <button name="decision" value="rejected">Reject</button>
            </form>
          )}
        </div>
      ))}
      {!rows.length && <p>No payout requests.</p>}
    </>
  )
}
