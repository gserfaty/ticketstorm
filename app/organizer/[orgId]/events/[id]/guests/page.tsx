import Link from 'next/link'
import PrintButton from '../../../../../../components/PrintButton.tsx'
import { fmtDateTime } from '../../../../../../lib/format.ts'
import { guestList, ORDER_ROLES } from '../../../../../../lib/orderadmin.ts'
import { loadEvent } from '../../../../guard.ts'

export const dynamic = 'force-dynamic'

export default async function Guests({ params }: { params: Promise<{ orgId: string; id: string }> }) {
  const { orgId, id } = await params
  const { e } = await loadEvent(orgId, id, ORDER_ROLES)
  const g = guestList(e.id)
  const here = g.filter((x) => x.status === 'used').length
  return (
    <>
      <h1>Guest list: {e.title}</h1>
      <p className="muted noprint"><Link href={`/organizer/${orgId}/events/${e.id}`}>Back to event</Link> · <Link href={`/organizer/${orgId}/events/${e.id}/orders`}>Orders and will-call</Link></p>
      <p>{g.length} guests · {here} checked in · {g.filter((x) => x.delivery === 'willcall' && !x.picked_up_at).length} will-call tickets not yet picked up</p>
      <PrintButton />
      <table>
        <thead><tr><th align="left">Name</th><th align="left">Seat</th><th align="left">Delivery</th><th align="left">Status</th></tr></thead>
        <tbody>
          {g.map((x) => (
            <tr key={x.ticket_id}>
              <td>{x.guest}</td>
              <td>{x.row ? `${x.section} ${x.row}-${x.number}` : `GA ${x.section}`}</td>
              <td>{x.delivery === 'willcall' ? (x.picked_up_at ? `will-call, picked up ${fmtDateTime(x.picked_up_at, e.tz)}` : 'WILL-CALL: not picked up') : x.delivery}</td>
              <td>{x.status === 'used' ? 'checked in' : x.status === 'listed' ? 'listed for resale' : 'not yet'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!g.length && <p>No guests yet.</p>}
    </>
  )
}
