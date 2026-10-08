import Link from 'next/link'
import { redirect } from 'next/navigation'
import { db } from '../../../../lib/db.ts'
import { money } from '../../../../lib/format.ts'
import { liveHold } from '../../../../lib/orders.ts'
import { protectionPct, quote } from '../../../../lib/pricing.ts'
import { getSession } from '../../../../lib/session.ts'
import { chooseProtection } from '../../actions.ts'

export const dynamic = 'force-dynamic'

// Step between the seat hold and payment: one clear yes/no for ticket protection.
export default async function ProtectionStep({ params }: { params: Promise<{ holdId: string }> }) {
  const holdId = Number((await params).holdId)
  const session = await getSession()
  const hold = session && Number.isInteger(holdId) ? liveHold(holdId, session.token) : undefined
  if (!hold) redirect(`/checkout/${holdId}`) // the checkout page explains an expired hold
  const q = quote(hold!.id)
  const face = q.lines.reduce((n, l) => n + (l.eventId === hold!.event_id ? l.unit : 0), 0)
  const premium = Math.round(((face - q.discount) * protectionPct()) / 100)
  if (q.lines.some((l) => l.listingId) || premium <= 0) redirect(`/checkout/${holdId}`)
  const ev = db.prepare('SELECT title FROM events WHERE id = ?').get(hold!.event_id) as { title: string }
  return (
    <>
      <h1>Protect your tickets?</h1>
      <div className="card">
        <p><strong>{ev.title}</strong> · {q.lines.length} ticket{q.lines.length === 1 ? '' : 's'}</p>
        <p>Ticket protection costs <strong>{money(premium)}</strong> ({protectionPct()}% of the tickets, no tax). If you cannot go, file a claim from your order and get everything back except the protection fee.</p>
        <p className="muted">Total now {money(q.total)}; with protection {money(q.total + premium)}.</p>
        <form action={chooseProtection} className="row">
          <input type="hidden" name="holdId" value={holdId} />
          <button name="choice" value="yes">Add protection ({money(premium)})</button>
          <button name="choice" value="no">No thanks</button>
        </form>
      </div>
      <p><Link href={`/checkout/${holdId}`}>Skip to checkout</Link></p>
    </>
  )
}
