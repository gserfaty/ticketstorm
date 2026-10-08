import Flash from '../../../components/Flash.tsx'
import OrderTools from '../../../components/OrderTools.tsx'
import { db } from '../../../lib/db.ts'
import { likeEscape } from '../../../lib/format.ts'
import type { OrderRow } from '../../../lib/orderadmin.ts'
import { requireAdmin } from '../../../lib/session.ts'
import { adminOrderHold, adminOrderRefund, adminOrderRelease, adminOrderResend } from '../actions.ts'

export const dynamic = 'force-dynamic'

export default async function AdminOrders({ searchParams }: { searchParams: Promise<{ q?: string; error?: string; notice?: string }> }) {
  await requireAdmin()
  const sp = await searchParams
  const q = (sp.q ?? '').trim()
  const like = `%${likeEscape(q)}%`
  const rows = q
    ? (db
        .prepare(
          `SELECT o.id, o.email, u.name, o.status, o.total, o.review_reason, o.source, o.created_at,
             (SELECT coalesce(sum(amount), 0) FROM payments WHERE order_id = o.id AND kind = 'charge' AND status = 'succeeded') AS paid,
             (SELECT coalesce(sum(amount), 0) FROM payments WHERE order_id = o.id AND kind = 'refund' AND status = 'succeeded') AS refunded
           FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE o.id = ? OR o.email LIKE ? ESCAPE '\\' ORDER BY o.id DESC LIMIT 30`,
        )
        .all(/^\d+$/.test(q) ? Number(q) : 0, like) as OrderRow[])
    : []
  return (
    <>
      <h1>Orders</h1>
      <Flash error={sp.error} notice={sp.notice} />
      <form className="filters"><input name="q" defaultValue={q} placeholder="Order # or email" aria-label="Search orders" /><button>Search</button></form>
      {rows.map((o) => <OrderTools key={o.id} o={o} tz="UTC" refund={adminOrderRefund} resend={adminOrderResend} hold={adminOrderHold} release={adminOrderRelease} />)}
    </>
  )
}
