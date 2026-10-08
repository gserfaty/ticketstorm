import AccountNav from '../../../components/AccountNav.tsx'
import Flash from '../../../components/Flash.tsx'
import { fmtDateTime, money } from '../../../lib/format.ts'
import { balance } from '../../../lib/ledger.ts'
import { payoutsOf } from '../../../lib/payouts.ts'
import { requireUser } from '../../../lib/session.ts'
import { requestPayoutAction } from '../actions.ts'

export const dynamic = 'force-dynamic'

export default async function Payouts({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const user = await requireUser()
  const account = `user:${user.id}`
  const bal = balance(account)
  const rows = payoutsOf(account)
  return (
    <>
      <h1>Account</h1>
      <AccountNav here="payouts" />
      <Flash {...(await searchParams)} />
      <p>Resale balance: <strong>{money(bal)}</strong> (what you earned selling tickets, after the seller fee, minus payouts already requested).</p>
      <form action={requestPayoutAction} className="stack">
        <label>Payout $ <input name="amount" inputMode="decimal" pattern="\d{1,7}(\.\d{1,2})?" size={8} required defaultValue={bal > 0 ? (bal / 100).toFixed(2) : ''} /></label>
        <button disabled={bal <= 0}>Request payout</button>
      </form>
      <p className="muted">Payouts are simulated: an admin marks them paid. A request reserves the amount at once; if it is rejected the money returns to your balance.</p>
      <h2>Requests</h2>
      {rows.map((p) => <div className="card" key={p.id}>#{p.id} · {money(p.amount)} · <span className="badge">{p.status}</span> <span className="muted">{fmtDateTime(p.created_at, 'UTC')} UTC</span></div>)}
      {!rows.length && <p>None yet.</p>}
    </>
  )
}
