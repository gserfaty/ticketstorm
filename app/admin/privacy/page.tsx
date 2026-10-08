import Flash from '../../../components/Flash.tsx'
import { db } from '../../../lib/db.ts'
import { likeEscape } from '../../../lib/format.ts'
import { requireAdmin } from '../../../lib/session.ts'
import { adminErase } from '../actions.ts'

export const dynamic = 'force-dynamic'

export default async function Privacy({ searchParams }: { searchParams: Promise<{ q?: string; error?: string; notice?: string }> }) {
  await requireAdmin()
  const sp = await searchParams
  const q = (sp.q ?? '').trim()
  const rows = q
    ? (db.prepare("SELECT id, email, name, role, status FROM users WHERE email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR id = ? ORDER BY id LIMIT 10").all(`%${likeEscape(q)}%`, `%${likeEscape(q)}%`, /^\d+$/.test(q) ? Number(q) : 0) as { id: number; email: string; name: string; role: string; status: string }[])
    : []
  return (
    <>
      <h1>Privacy requests (GDPR)</h1>
      <p className="muted">Export everything we hold about a user, or erase them (the account is anonymized, orders and ledger rows stay with no personal fields). Both use the same functions as the self-service account page. Every use is audited. Admin accounts cannot be erased.</p>
      <Flash error={sp.error} notice={sp.notice} />
      <form className="filters"><input name="q" defaultValue={q} placeholder="Email, name or user id" aria-label="Find a user" /><button>Search</button></form>
      {rows.map((u) => (
        <div className="card row" key={u.id}>
          #{u.id} · {u.email} · {u.name || 'no name'} · <span className="badge">{u.role}</span> <span className="badge">{u.status}</span>
          <a className="btn" href={`/admin/privacy/export?id=${u.id}`}>Export JSON</a>
          {u.role !== 'admin' && u.status !== 'deleted' && (
            <form action={adminErase} className="row">
              <input type="hidden" name="userId" value={u.id} />
              <label><input type="checkbox" name="confirm" required /> I confirm erasure of user #{u.id}</label>
              <button>Erase</button>
            </form>
          )}
        </div>
      ))}
    </>
  )
}
