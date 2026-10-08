import { db } from '../../../lib/db.ts'
import { requireAdmin } from '../../../lib/session.ts'

export const dynamic = 'force-dynamic'

export default async function Audit() {
  await requireAdmin()
  const rows = db.prepare('SELECT a.id, a.created_at, a.action, a.target, a.data, u.email FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 200').all() as { id: number; created_at: string; action: string; target: string; data: string | null; email: string | null }[]
  return (
    <>
      <h1>Audit log</h1>
      <p className="muted">Newest 200 admin and organizer actions, including impersonation start and stop.</p>
      <table>
        <tbody>{rows.map((r) => <tr key={r.id}><td>{r.created_at.slice(0, 19)}</td><td>{r.email}</td><td>{r.action}</td><td>{r.target}</td><td className="muted">{r.data}</td></tr>)}</tbody>
      </table>
    </>
  )
}
