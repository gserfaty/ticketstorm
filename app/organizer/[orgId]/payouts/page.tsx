import Link from 'next/link'
import Flash from '../../../../components/Flash.tsx'
import { db } from '../../../../lib/db.ts'
import { fmtDateTime, money } from '../../../../lib/format.ts'
import { balance } from '../../../../lib/ledger.ts'
import { FINANCE_ROLES } from '../../../../lib/organizer.ts'
import { payoutsOf } from '../../../../lib/payouts.ts'
import { ENDED_AFTER_MS } from '../../../../lib/reports.ts'
import { requireOrgRole } from '../../../../lib/session.ts'
import { orgPayoutAction, settleEventAction } from '../../actions.ts'

export const dynamic = 'force-dynamic'

export default async function OrgPayouts({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const orgId = Number((await params).orgId)
  await requireOrgRole(orgId, FINANCE_ROLES)
  const account = `org:${orgId}`
  const settled = db.prepare('SELECT s.event_id, s.net, s.fees, s.tax, s.collected, s.created_at, e.title FROM settlements s JOIN events e ON e.id = s.event_id WHERE s.org_id = ? ORDER BY s.created_at DESC').all(orgId) as
    { event_id: number; net: number; fees: number; tax: number; collected: number; created_at: string; title: string }[]
  const due = (db.prepare("SELECT e.id, e.title, e.starts_at FROM events e WHERE e.org_id = ? AND e.status IN ('published','rescheduled','postponed') AND e.starts_at < ? AND NOT EXISTS (SELECT 1 FROM settlements WHERE event_id = e.id) ORDER BY e.starts_at").all(orgId, new Date(Date.now() - ENDED_AFTER_MS).toISOString())) as { id: number; title: string; starts_at: string }[]
  const bal = balance(account)
  return (
    <>
      <h1>Payouts</h1>
      <p><Link href={`/organizer/${orgId}`}>Back to organization</Link></p>
      <Flash {...(await searchParams)} />
      <p>Organization balance: <strong>{money(bal)}</strong></p>
      <h2>Settle finished events</h2>
      <p className="muted">Settling moves an event&apos;s revenue (face value after promos and refunds) into the balance. Platform fees and tax stay with TicketStorm. It can only run once per event.</p>
      {due.map((d) => (
        <form action={settleEventAction} className="card row" key={d.id}>
          <input type="hidden" name="eventId" value={d.id} />
          {d.title} <button>Settle</button>
        </form>
      ))}
      {!due.length && <p>Nothing waiting to be settled.</p>}
      <h2>Settled events</h2>
      {settled.map((s) => <div className="card" key={s.event_id}>{s.title} · to you {money(s.net)} · platform fees {money(s.fees)} · tax {money(s.tax)} · collected {money(s.collected)} <span className="muted">{fmtDateTime(s.created_at, 'UTC')} UTC</span></div>)}
      {!settled.length && <p>None yet.</p>}
      <h2>Request a payout</h2>
      <form action={orgPayoutAction} className="stack">
        <input type="hidden" name="orgId" value={orgId} />
        <label>Amount $ <input name="amount" inputMode="decimal" pattern="\d{1,8}(\.\d{1,2})?" size={10} required defaultValue={bal > 0 ? (bal / 100).toFixed(2) : ''} /></label>
        <button disabled={bal <= 0}>Request payout</button>
      </form>
      {payoutsOf(account).map((p) => <div className="card" key={p.id}>#{p.id} · {money(p.amount)} · <span className="badge">{p.status}</span></div>)}
    </>
  )
}
