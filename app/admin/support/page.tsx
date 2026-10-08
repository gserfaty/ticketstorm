import Link from 'next/link'
import { db } from '../../../lib/db.ts'
import { fmtDateTime } from '../../../lib/format.ts'
import { requireAdmin } from '../../../lib/session.ts'

export const dynamic = 'force-dynamic'

export default async function AdminSupport() {
  await requireAdmin()
  const rows = db.prepare("SELECT id, email, kind, subject, status, created_at FROM support_tickets ORDER BY (status = 'open') DESC, id DESC LIMIT 100").all() as { id: number; email: string; kind: string; subject: string; status: string; created_at: string }[]
  return (
    <>
      <h1>Support tickets</h1>
      {rows.map((t) => <div className="card" key={t.id}><Link href={`/admin/support/${t.id}`}>#{t.id} {t.subject}</Link> · {t.email} · {t.kind} · <span className="badge">{t.status}</span> <span className="muted">{fmtDateTime(t.created_at, 'UTC')} UTC</span></div>)}
      {!rows.length && <p>None.</p>}
    </>
  )
}
