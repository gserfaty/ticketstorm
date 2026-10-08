import Flash from '../../../components/Flash.tsx'
import { db } from '../../../lib/db.ts'
import { likeEscape } from '../../../lib/format.ts'
import { requireAdmin } from '../../../lib/session.ts'
import { impersonateUser, setUserFlag, setUserRole, setUserStatus } from '../actions.ts'

export const dynamic = 'force-dynamic'

export default async function Users({ searchParams }: { searchParams: Promise<{ q?: string; error?: string; notice?: string }> }) {
  await requireAdmin()
  const sp = await searchParams
  const like = `%${likeEscape(sp.q ?? '')}%`
  const users = db
    .prepare("SELECT id, email, name, role, status, flagged FROM users WHERE email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' ORDER BY id LIMIT 100")
    .all(like, like) as { id: number; email: string; name: string; role: string; status: string; flagged: number }[]
  return (
    <>
      <h1>Users</h1>
      <Flash {...sp} />
      <form className="filters"><input name="q" defaultValue={sp.q ?? ''} placeholder="Search email or name" aria-label="Search" /><button>Search</button></form>
      {users.map((u) => (
        <div className="card" key={u.id}>
          {u.name} &lt;{u.email}&gt; <span className="badge">{u.role}</span> <span className="badge">{u.status}</span>{u.flagged ? <> <span className="badge">flagged</span></> : null}
          <form action={setUserStatus} className="buy"><input type="hidden" name="userId" value={u.id} /><input type="hidden" name="status" value={u.status === 'blocked' ? 'active' : 'blocked'} /><button>{u.status === 'blocked' ? 'Unblock' : 'Block'}</button></form>
          <form action={setUserRole} className="buy"><input type="hidden" name="userId" value={u.id} /><input type="hidden" name="role" value={u.role === 'admin' ? 'fan' : 'admin'} /><button>Make {u.role === 'admin' ? 'fan' : 'admin'}</button></form>
          <form action={setUserFlag} className="buy"><input type="hidden" name="userId" value={u.id} /><input type="hidden" name="flagged" value={u.flagged ? '0' : '1'} /><button>{u.flagged ? 'Unflag' : 'Flag'}</button></form>
          {u.role !== 'admin' && u.status === 'active' && <form action={impersonateUser} className="buy"><input type="hidden" name="userId" value={u.id} /><button>View as this user</button></form>}
        </div>
      ))}
    </>
  )
}
