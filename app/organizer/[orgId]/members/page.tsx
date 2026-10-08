import Link from 'next/link'
import Flash from '../../../../components/Flash.tsx'
import { db } from '../../../../lib/db.ts'
import { ALL_ROLES, MANAGE_ROLES } from '../../../../lib/organizer.ts'
import { requireOrgRole } from '../../../../lib/session.ts'
import { addMember, removeMember } from '../../actions.ts'

export const dynamic = 'force-dynamic'

export default async function Members({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const orgId = Number((await params).orgId)
  const { role } = await requireOrgRole(orgId, MANAGE_ROLES)
  const members = db.prepare('SELECT u.id, u.email, u.name, m.role FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY u.email').all(orgId) as { id: number; email: string; name: string; role: string }[]
  return (
    <>
      <h1>Members</h1>
      <p><Link href={`/organizer/${orgId}`}>Back</Link></p>
      <Flash {...(await searchParams)} />
      {members.map((m) => (
        <div className="card" key={m.id}>
          {m.name} &lt;{m.email}&gt; · <span className="badge">{m.role}</span>
          {role === 'owner' && (
            <form action={removeMember} className="buy"><input type="hidden" name="orgId" value={orgId} /><input type="hidden" name="userId" value={m.id} /><button>Remove</button></form>
          )}
        </div>
      ))}
      {role === 'owner' ? (
        <form action={addMember} className="stack">
          <h2>Add or change a member</h2>
          <input type="hidden" name="orgId" value={orgId} />
          <input name="email" type="email" placeholder="Their account email" required />
          <select name="role" aria-label="Role">{ALL_ROLES.map((r) => <option key={r}>{r}</option>)}</select>
          <button>Save member</button>
        </form>
      ) : <p className="muted">Only owners can change members.</p>}
    </>
  )
}
