import Link from 'next/link'
import { userTickets } from '../../lib/support.ts'
import { requireUser } from '../../lib/session.ts'

export const dynamic = 'force-dynamic'

export default async function Support() {
  const user = await requireUser()
  const tickets = userTickets(user.id)
  return (
    <>
      <h1>My support tickets</h1>
      <p><Link href="/help#contact">New message</Link></p>
      {tickets.map((t) => <div className="card" key={t.id}><Link href={`/support/${t.id}`}>#{t.id} {t.subject}</Link> <span className="badge">{t.status}</span></div>)}
      {!tickets.length && <p>No tickets yet.</p>}
    </>
  )
}
