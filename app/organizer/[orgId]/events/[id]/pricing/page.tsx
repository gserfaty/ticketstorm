import Link from 'next/link'
import Flash from '../../../../../../components/Flash.tsx'
import { db } from '../../../../../../lib/db.ts'
import { fmtDateTime, money, toLocalInput } from '../../../../../../lib/format.ts'
import { feeDefaults } from '../../../../../../lib/pricing.ts'
import { loadEvent } from '../../../../guard.ts'
import { addAddonAction, addLevel, addPromoAction, removeAddonAction, removeLevel, expirePromoAction, removePromoAction, repriceLevel, saveDynamic, saveFees, saveLimits, saveOffer, saveOnsale } from '../../../../actions.ts'

export const dynamic = 'force-dynamic'

export default async function Pricing({ params, searchParams }: { params: Promise<{ orgId: string; id: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const { orgId, id } = await params
  const { e } = await loadEvent(orgId, id)
  type Level = { id: number; name: string; price_cents: number; ticket_type: string; perks: string | null; dyn_min_cents: number | null; dyn_max_cents: number | null; dyn_k: number | null; dyn_j: number | null }
  const levels = db.prepare('SELECT id, name, price_cents, ticket_type, perks, dyn_min_cents, dyn_max_cents, dyn_k, dyn_j FROM price_levels WHERE event_id = ? AND event_ids IS NULL ORDER BY price_cents').all(e.id) as Level[]
  const fees = { ...feeDefaults(), ...(e.fee_rule ? JSON.parse(e.fee_rule) : {}) }
  const lim = db.prepare('SELECT ticket_limit, coalesce(order_limit, ticket_limit) AS order_limit FROM events WHERE id = ?').get(e.id) as { ticket_limit: number; order_limit: number }
  const offers = new Map((db.prepare('SELECT name, pct_off FROM offers WHERE event_id = ?').all(e.id) as { name: string; pct_off: number }[]).map((o) => [o.name, o.pct_off]))
  const addons = db.prepare('SELECT id, kind, name, price_cents, inventory, sold FROM addons WHERE event_id = ? ORDER BY id').all(e.id) as { id: number; kind: string; name: string; price_cents: number; inventory: number; sold: number }[]
  const promos = db
    .prepare('SELECT id, code, kind, amount, max_uses, uses, expires_at, event_id FROM promo_codes WHERE org_id = ? AND (event_id = ? OR event_id IS NULL) ORDER BY id')
    .all(e.org_id, e.id) as { id: number; code: string; kind: string; amount: number; max_uses: number; uses: number; expires_at: string | null; event_id: number | null }[]
  const dollars = (c: number | null) => (c === null ? '' : (c / 100).toFixed(2))
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
          {l.name} ({l.ticket_type}) · {money(l.price_cents)}{l.perks && <div className="muted">Includes: {l.perks}</div>}
          <form action={repriceLevel} className="buy">{hidden}<input type="hidden" name="levelId" value={l.id} /><input name="price" type="number" step="0.01" min="0" placeholder="New price $" required aria-label="New price" /><button>Re-price</button></form>
          <form action={saveDynamic} className="buy">
            {hidden}<input type="hidden" name="levelId" value={l.id} />
            <label>Min $ <input name="min" type="number" step="0.01" min="0" defaultValue={dollars(l.dyn_min_cents)} size={6} /></label>
            <label>Max $ <input name="max" type="number" step="0.01" min="0" defaultValue={dollars(l.dyn_max_cents)} size={6} /></label>
            <label title="Price rises by this fraction of base when 100% sold, e.g. 0.5 = +50%">k <input name="k" type="number" step="0.01" min="0" max="10" defaultValue={l.dyn_k ?? ''} /></label>
            <label title="Same, for waiting-room depth">j <input name="j" type="number" step="0.01" min="0" max="10" defaultValue={l.dyn_j ?? ''} /></label>
            <button>Save dynamic pricing</button>
          </form>
          <form action={removeLevel}>{hidden}<input type="hidden" name="levelId" value={l.id} /><button>Remove</button></form>
        </div>
      ))}
      <form action={addLevel} className="stack">
        {hidden}
        <input name="name" placeholder="Level name (e.g. Floor)" required />
        <input name="price" type="number" step="0.01" min="0" placeholder="Price $" required />
        <select name="type" aria-label="Ticket type"><option>standard</option><option>vip</option><option>platinum</option><option>accessible</option><option>standing</option></select>
        <input name="color" type="color" defaultValue="#3b82f6" aria-label="Color" />
        <input name="perks" placeholder="Perks (VIP / Meet & Greet package contents)" maxLength={300} />
        <button>Add level</button>
      </form>
      <p className="muted">Dynamic price = clamp(base × (1 + k × share sold + j × waiting-room depth), min, max). A ticket keeps the price it was held at.</p>
      <h2>Ticket limits</h2>
      <form action={saveLimits} className="stack">
        {hidden}
        <label>Per order <input name="order_limit" type="number" min="1" max="100" defaultValue={lim.order_limit} /></label>
        <label>Per event, per account (across orders) <input name="ticket_limit" type="number" min="1" max="100" defaultValue={lim.ticket_limit} /></label>
        <button>Save limits</button>
      </form>
      <h2>Fees</h2>
      <form action={saveFees} className="stack">
        {hidden}
        <label>Service fee % <input name="service_pct" type="number" min="0" max="50" defaultValue={fees.service_pct} /></label>
        <label>Facility charge (cents) <input name="facility_cents" type="number" min="0" defaultValue={fees.facility_cents} /></label>
        <label>Order processing fee (cents) <input name="order_cents" type="number" min="0" defaultValue={fees.order_cents} /></label>
        <label>Delivery fee per order (cents) <input name="delivery_cents" type="number" min="0" defaultValue={fees.delivery_cents ?? 0} /></label>
        <button>Save fees</button>
      </form>
      <h2>Offers</h2>
      <p className="muted">Percent off the face price of a ticket, chosen per ticket at checkout. 0 removes the offer.</p>
      {['child', 'senior', 'student'].map((n) => (
        <form action={saveOffer} className="buy" key={n}>{hidden}<input type="hidden" name="name" value={n} /><label>{n} % off <input name="pct" type="number" min="0" max="100" defaultValue={offers.get(n) ?? 0} /></label><button>Save</button></form>
      ))}
      <h2>Add-ons</h2>
      {addons.map((a) => (
        <div className="card" key={a.id}>
          {a.name} ({a.kind}) · {money(a.price_cents)} · {a.sold}/{a.inventory} sold
          <form action={removeAddonAction}>{hidden}<input type="hidden" name="addonId" value={a.id} /><button>Remove</button></form>
        </div>
      ))}
      <form action={addAddonAction} className="stack">
        {hidden}
        <select name="kind" aria-label="Kind"><option>parking</option><option>merch</option><option>hospitality</option></select>
        <input name="name" placeholder="Name (e.g. Lot A parking)" required />
        <input name="price" type="number" step="0.01" min="0" placeholder="Price $" required />
        <input name="inventory" type="number" min="0" placeholder="Inventory" required />
        <button>Add add-on</button>
      </form>
      <h2>Promo codes</h2>
      {promos.map((p) => (
        <div className="card" key={p.id}>
          <code>{p.code}</code> · {p.kind === 'pct' ? `${p.amount}% off` : `${money(p.amount)} off`} · {p.uses}/{p.max_uses} used · {p.event_id ? 'this event' : 'all your events'}
          {p.expires_at && <> · expires {fmtDateTime(p.expires_at, e.tz)}</>}
          <form action={p.uses > 0 ? expirePromoAction : removePromoAction}>{hidden}<input type="hidden" name="promoId" value={p.id} /><button>{p.uses > 0 ? 'Expire now' : 'Delete'}</button></form>
        </div>
      ))}
      <form action={addPromoAction} className="stack">
        {hidden}
        <input name="code" placeholder="Code" required pattern="[A-Za-z0-9_\-]{3,20}" />
        <select name="kind" aria-label="Kind"><option value="pct">percent off</option><option value="fixed">fixed $ off</option></select>
        <input name="amount" type="number" step="0.01" min="0.01" placeholder="Percent or dollars" required />
        <input name="maxUses" type="number" min="1" placeholder="Max uses" required />
        <label>Expires ({e.tz}, optional) <input type="datetime-local" name="expiresAt" /></label>
        <select name="scope" aria-label="Scope"><option value="event">This event only</option><option value="org">All my events</option></select>
        <button>Create code</button>
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
