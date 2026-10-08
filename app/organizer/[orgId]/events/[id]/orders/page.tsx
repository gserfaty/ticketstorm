import Link from 'next/link'
import Flash from '../../../../../../components/Flash.tsx'
import OrderTools from '../../../../../../components/OrderTools.tsx'
import { searchOrders, ORDER_ROLES } from '../../../../../../lib/orderadmin.ts'
import { loadEvent } from '../../../../guard.ts'
import { orderComp, orderHold, orderMove, orderRefund, orderRelease, orderResend } from '../../../../actions.ts'

export const dynamic = 'force-dynamic'

export default async function EventOrders({ params, searchParams }: { params: Promise<{ orgId: string; id: string }>; searchParams: Promise<{ q?: string; status?: string; error?: string; notice?: string }> }) {
  const { orgId, id } = await params
  const { e } = await loadEvent(orgId, id, ORDER_ROLES)
  const sp = await searchParams
  const rows = searchOrders(e.id, (sp.q ?? '').trim(), sp.status ?? '')
  return (
    <>
      <h1>Orders: {e.title}</h1>
      <p><Link href={`/organizer/${orgId}/events/${e.id}`}>Back to event</Link></p>
      <Flash error={sp.error} notice={sp.notice} />
      <form className="filters">
        <input name="q" defaultValue={sp.q ?? ''} placeholder="Order #, email or name" aria-label="Search orders" />
        <select name="status" defaultValue={sp.status ?? ''} aria-label="Status">
          <option value="">Any status</option>
          {['paid', 'review', 'partially_refunded', 'refunded', 'cancelled'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
        </select>
        <button>Search</button>
      </form>
      {rows.map((o) => <OrderTools key={o.id} o={o} tz={e.tz} refund={orderRefund} resend={orderResend} hold={orderHold} release={orderRelease} move={orderMove} />)}
      {!rows.length && <p>No orders found.</p>}
      <h2>Complimentary tickets</h2>
      <p className="muted">A $0 order straight from inventory (free seats, or seats you blocked as comps). Comps do not count toward the buyer&apos;s ticket limit.</p>
      <form action={orderComp} className="stack">
        <input type="hidden" name="eventId" value={e.id} />
        <input type="hidden" name="page" value="orders" />
        <input name="email" type="email" placeholder="Recipient email" required />
        <textarea name="seats" rows={3} placeholder={'One seat per line\nSection, Row, Seat   (e.g. 101, A, 5)\nSection   (general admission)'} required />
        <input name="note" placeholder="Note to the recipient (optional)" maxLength={200} />
        <button>Send comp tickets</button>
      </form>
    </>
  )
}
