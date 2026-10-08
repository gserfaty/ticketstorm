import Link from 'next/link'
import { redirect } from 'next/navigation'
import { db } from '../../lib/db.ts'
import { requireUser } from '../../lib/session.ts'

export const dynamic = 'force-dynamic'

export default async function Organizer() {
  const u = await requireUser()
  const orgs = db
    .prepare('SELECT o.id, o.name, o.status, m.role FROM org_members m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ? ORDER BY o.name')
    .all(u.id) as { id: number; name: string; status: string; role: string }[]
  if (!orgs.length) redirect('/become-organizer')
  return (
    <>
      <h1>Your organizations</h1>
      {orgs.map((o) => (
        <div className="card" key={o.id}>
          <Link href={`/organizer/${o.id}`}>{o.name}</Link> <span className="badge">{o.status}</span> <span className="muted">{o.role}</span>
        </div>
      ))}
      <p><Link href="/become-organizer">Create another organization</Link></p>
    </>
  )
}
