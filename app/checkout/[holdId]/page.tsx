import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { db } from '../../../lib/db.ts'
import { newCaptcha } from '../../../lib/defense.ts'
import { liveHold } from '../../../lib/orders.ts'
import { listSavedCards } from '../../../lib/payments.ts'
import { quote } from '../../../lib/pricing.ts'
import { money, fmtDateTimeTz } from '../../../lib/format.ts'
import { getSession, getUser } from '../../../lib/session.ts'
import PayForm from '../../../components/PayForm.tsx'
import { pay } from '../actions.ts'

export const dynamic = 'force-dynamic'

export default async function Checkout({ params, searchParams }: { params: Promise<{ holdId: string }>; searchParams: Promise<{ error?: string }> }) {
  const holdId = Number((await params).holdId)
  const { error } = await searchParams
  const session = await getSession()
  const hold = session && Number.isInteger(holdId) ? liveHold(holdId, session.token) : undefined
  if (!hold) {
    return (
      <>
        <h1>Checkout</h1>
        {error && <p className="error">{error}</p>}
        <p>Your hold has expired or was released. <Link href="/">Find tickets again</Link></p>
      </>
    )
  }
  const ev = db.prepare('SELECT e.title, e.slug, e.starts_at, v.name AS venue, v.tz FROM events e JOIN venues v ON v.id = e.venue_id WHERE e.id = ?').get(hold.event_id) as {
    title: string; slug: string; starts_at: string; venue: string; tz: string
  }
  const q = quote(hold.id)
  const user = await getUser()
  return (
    <>
      <h1>Checkout</h1>
      <div className="card">
        <strong>{ev.title}</strong>
        <div className="muted">{ev.venue} · {fmtDateTimeTz(ev.starts_at, ev.tz)}</div>
        <ul>{q.lines.map((l) => <li key={l.inventoryId}>{l.label} · {money(l.unit)} + {money(l.fee)} fees + {money(l.tax)} tax</li>)}</ul>
        <table>
          <tbody>
            <tr><td>Tickets</td><td>{money(q.subtotal)}</td></tr>
            <tr><td>Service and facility fees</td><td>{money(q.fees - q.orderFee)}</td></tr>
            <tr><td>Order processing fee</td><td>{money(q.orderFee)}</td></tr>
            <tr><td>Tax</td><td>{money(q.tax)}</td></tr>
            <tr><td><strong>Total</strong></td><td><strong>{money(q.total)}</strong></td></tr>
          </tbody>
        </table>
      </div>
      {error && <p className="error">{error}</p>}
      <PayForm action={pay} holdId={hold.id} idemKey={randomUUID()} expiresAt={hold.expires_at} email={user?.email ?? null} saved={user ? listSavedCards(user.id) : []} canSave={!!user} total={money(q.total)} captcha={newCaptcha()} />
      <p><Link href={`/events/${ev.slug}/tickets`}>Back to seat map</Link></p>
    </>
  )
}
