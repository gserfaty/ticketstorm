import Link from 'next/link'
import { db } from '../../lib/db.ts'
import { fmtDateTime, money } from '../../lib/format.ts'
import { requireUser } from '../../lib/session.ts'

export const dynamic = 'force-dynamic'
const TABS = ['upcoming', 'past', 'cancelled']

export default async function Orders({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser()
  const t = (await searchParams).tab
  const tab = TABS.includes(t ?? '') ? t! : 'upcoming'
  const cancelled = "o.status IN ('cancelled','refunded')"
  const where = tab === 'cancelled' ? cancelled : `NOT ${cancelled} AND e.starts_at ${tab === 'past' ? '<' : '>='} ?`
  const rows = db
    .prepare(
      `SELECT o.id, o.total, o.status, o.created_at, e.title, e.starts_at, v.tz FROM orders o JOIN events e ON e.id = o.event_id JOIN venues v ON v.id = e.venue_id
       WHERE o.user_id = ? AND ${where} ORDER BY o.id DESC`,
    )
    .all(user.id, ...(tab === 'cancelled' ? [] : [new Date().toISOString()])) as { id: number; total: number; status: string; created_at: string; title: string; starts_at: string; tz: string }[]
  return (
    <>
      <h1>Orders</h1>
      <p className="genres">{TABS.map((x) => <Link key={x} href={`/orders?tab=${x}`} className={x === tab ? 'on' : ''}>{x}</Link>)}</p>
      {rows.map((o) => (
        <div className="card" key={o.id}>
          <Link href={`/orders/${o.id}`}>Order #{o.id}</Link> · {o.title} · {fmtDateTime(o.starts_at, o.tz)} · {money(o.total)} · {o.status}
        </div>
      ))}
      {rows.length === 0 && <p>No {tab} orders.</p>}
    </>
  )
}
