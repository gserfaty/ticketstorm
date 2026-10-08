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
        <li><Link href="/admin/review">Orders in review</Link> ({n("SELECT count(*) AS n FROM orders WHERE status = 'review'")})</li>
        <li><Link href="/admin/claims">Protection claims</Link> ({n("SELECT count(*) AS n FROM claims WHERE status = 'submitted'")} open)</li>
        <li><Link href="/admin/orders">Orders (search, refund, void)</Link></li>
        <li><Link href="/admin/refunds">Failed refunds</Link> ({n('SELECT count(*) AS n FROM orders WHERE refund_error IS NOT NULL')})</li>
        <li><Link href="/admin/disputes">Chargebacks</Link> ({n("SELECT count(*) AS n FROM disputes WHERE status = 'open'")} open)</li>
        <li><Link href="/admin/reviews">Review moderation</Link> ({n("SELECT count(*) AS n FROM reviews WHERE status = 'pending'")} pending)</li>
        <li><Link href="/admin/payouts">Payouts</Link> ({n("SELECT count(*) AS n FROM payouts WHERE status = 'requested'")} requested)</li>
        <li><Link href="/admin/fraud">Fraud and bots</Link></li>
        <li><Link href="/admin/scalpers">Possible scalpers</Link> ({n("SELECT count(*) AS n FROM users WHERE flagged = 1")} flagged accounts)</li>
        <li><Link href="/admin/support">Support tickets</Link> ({n("SELECT count(*) AS n FROM support_tickets WHERE status = 'open'")} open)</li>
        <li><Link href="/admin/audit">Audit log</Link></li>
        <li><Link href="/admin/fees">Fee defaults</Link></li>
        <li><Link href="/admin/taxes">City taxes</Link></li>
        <li><Link href="/admin/flags">Feature flags</Link></li>
      </ul>
    </>
  )
}
