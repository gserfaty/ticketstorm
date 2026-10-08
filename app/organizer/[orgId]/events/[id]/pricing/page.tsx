import Link from 'next/link'
import Flash from '../../../../../../components/Flash.tsx'
import { db } from '../../../../../../lib/db.ts'
import { money, toLocalInput } from '../../../../../../lib/format.ts'
import { loadEvent } from '../../../../guard.ts'
import { addLevel, removeLevel, repriceLevel, saveFees, saveOnsale } from '../../../../actions.ts'

export const dynamic = 'force-dynamic'

export default async function Pricing({ params, searchParams }: { params: Promise<{ orgId: string; id: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const { orgId, id } = await params
  const { e } = await loadEvent(orgId, id)
  const levels = db.prepare('SELECT id, name, price_cents, ticket_type FROM price_levels WHERE event_id = ? AND event_ids IS NULL ORDER BY price_cents').all(e.id) as { id: number; name: string; price_cents: number; ticket_type: string }[]
  const fees = { service_pct: 10, facility_cents: 300, order_cents: 250, ...(e.fee_rule ? JSON.parse(e.fee_rule) : {}) }
  const hidden = (
    <>
      <input type="hidden" name="eventId" value={e.id} />
      <input type="hidden" name="page" value="pricing" />
    </>
  )
  return (
    <>
      <h1>Pricing: {e.title}</h1>
      <p><Link href={`/organizer/${orgId}/events/${e.id}`}>Back to event</Link></p>
      <Flash {...(await searchParams)} />
      <h2>Price levels</h2>
      {levels.map((l) => (
        <div className="card" key={l.id}>
          {l.name} ({l.ticket_type}) · {money(l.price_cents)}
          <form action={repriceLevel} className="buy">{hidden}<input type="hidden" name="levelId" value={l.id} /><input name="price" type="number" step="0.01" min="0" placeholder="New price $" required aria-label="New price" /><button>Re-price</button></form>
          <form action={removeLevel}>{hidden}<input type="hidden" name="levelId" value={l.id} /><button>Remove</button></form>
        </div>
      ))}
      <form action={addLevel} className="stack">
        {hidden}
        <input name="name" placeholder="Level name (e.g. Floor)" required />
        <input name="price" type="number" step="0.01" min="0" placeholder="Price $" required />
        <select name="type" aria-label="Ticket type"><option>standard</option><option>vip</option><option>platinum</option><option>accessible</option><option>standing</option></select>
        <input name="color" type="color" defaultValue="#3b82f6" aria-label="Color" />
        <button>Add level</button>
      </form>
      <h2>Fees</h2>
      <form action={saveFees} className="stack">
        {hidden}
        <label>Service fee % <input name="service_pct" type="number" min="0" max="50" defaultValue={fees.service_pct} /></label>
        <label>Facility charge (cents) <input name="facility_cents" type="number" min="0" defaultValue={fees.facility_cents} /></label>
        <label>Order processing fee (cents) <input name="order_cents" type="number" min="0" defaultValue={fees.order_cents} /></label>
        <button>Save fees</button>
      </form>
      <h2>On sale</h2>
      <form action={saveOnsale} className="stack">
        {hidden}
        <label>On-sale ({e.tz}); blank = immediately <input type="datetime-local" name="onsaleAt" defaultValue={e.onsale_at ? toLocalInput(e.onsale_at, e.tz) : ''} /></label>
        <button>Save</button>
      </form>
    </>
  )
}
