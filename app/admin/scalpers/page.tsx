import Link from 'next/link'
import Flash from '../../../components/Flash.tsx'
import { clusters, SCALPER_ACCOUNTS } from '../../../lib/scalpers.ts'
import { requireAdmin } from '../../../lib/session.ts'
import { cancelScalperOrders } from '../actions.ts'

export const dynamic = 'force-dynamic'

export default async function Scalpers({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  await requireAdmin()
  const all = clusters()
  return (
    <>
      <h1>Possible scalpers</h1>
      <Flash {...(await searchParams)} />
      <p className="muted">An event where {SCALPER_ACCOUNTS} or more different accounts paid with the same card fingerprint or from the same IP. Their registered accounts are flagged automatically (see <Link href="/admin/fraud">Fraud and bots</Link>). Cancelling refunds each live order in full through the normal refund function and puts the seats back on sale.</p>
      {all.map((c) => (
        <div className="card" key={`${c.eventId}${c.kind}${c.key}`}>
          <strong>{c.title}</strong> · same {c.kind === 'card' ? 'card' : 'IP'} <code>{c.key.slice(0, 12)}</code> · {c.accounts.length} accounts
          <ul>{c.accounts.map((a) => <li key={a.account}>{a.account}{a.userId ? '' : ' (guest)'}: orders {a.orders.map((o) => `#${o.id} ${o.status}`).join(', ')}</li>)}</ul>
          <form action={cancelScalperOrders}>
            <input type="hidden" name="eventId" value={c.eventId} />
            <input type="hidden" name="kind" value={c.kind} />
            <input type="hidden" name="key" value={c.key} />
            <button>Cancel and refund these {c.accounts.reduce((n, a) => n + a.orders.length, 0)} orders</button>
          </form>
        </div>
      ))}
      {!all.length && <p>No clusters.</p>}
    </>
  )
}
