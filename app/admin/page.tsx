import Link from 'next/link'
import { db } from '../../lib/db.ts'
import { requireAdmin } from '../../lib/session.ts'

export const dynamic = 'force-dynamic'

export default async function Admin() {
  await requireAdmin()
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n
  return (
    <>
      <h1>Admin</h1>
      <ul>
        <li><Link href="/admin/users">Users</Link> ({n('SELECT count(*) AS n FROM users')})</li>
        <li><Link href="/admin/orgs">Organizations</Link> ({n("SELECT count(*) AS n FROM orgs WHERE status = 'pending'")} pending)</li>
        <li><Link href="/admin/events">Events</Link> ({n("SELECT count(*) AS n FROM events WHERE approved = 0 AND status != 'draft'")} awaiting approval)</li>
        <li><Link href="/admin/refunds">Failed refunds</Link> ({n('SELECT count(*) AS n FROM orders WHERE refund_error IS NOT NULL')})</li>
        <li><Link href="/admin/flags">Feature flags</Link></li>
      </ul>
    </>
  )
}
