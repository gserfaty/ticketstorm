import Flash from '../../../components/Flash.tsx'
import { db } from '../../../lib/db.ts'
import { requireAdmin } from '../../../lib/session.ts'
import { setOrgStatus } from '../actions.ts'

export const dynamic = 'force-dynamic'

export default async function Orgs({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  await requireAdmin()
  const orgs = db
    .prepare("SELECT o.id, o.name, o.status, (SELECT u.email FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = o.id AND m.role = 'owner' LIMIT 1) AS owner FROM orgs o ORDER BY o.status = 'pending' DESC, o.id")
    .all() as { id: number; name: string; status: string; owner: string | null }[]
  return (
    <>
      <h1>Organizations</h1>
      <Flash {...(await searchParams)} />
      {orgs.map((o) => (
        <div className="card" key={o.id}>
          {o.name} <span className="badge">{o.status}</span> <span className="muted">{o.owner}</span>
          {(['approved', 'suspended'] as const).filter((s) => s !== o.status).map((s) => (
            <form action={setOrgStatus} className="buy" key={s}><input type="hidden" name="orgId" value={o.id} /><input type="hidden" name="status" value={s} /><button>{s === 'approved' ? 'Approve' : 'Suspend'}</button></form>
          ))}
        </div>
      ))}
    </>
  )
}
