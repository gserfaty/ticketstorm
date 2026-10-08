import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { db } from '../../../lib/db.ts'
import { newCaptcha } from '../../../lib/defense.ts'
import { liveHold } from '../../../lib/orders.ts'
import { listSavedCards } from '../../../lib/payments.ts'
import { parseOptions, protectionPct, quote } from '../../../lib/pricing.ts'
import { plan } from '../../../lib/installments.ts'
import { money, fmtDateTimeTz } from '../../../lib/format.ts'
import { currencyPref, getSession, getUser } from '../../../lib/session.ts'
import { approx, displayCurrency } from '../../../lib/currency.ts'
import { creditBalance } from '../../../lib/stored.ts'
import { addressOf } from '../../../lib/account.ts'
import { DELIVERY_LABEL } from '../../../lib/rules.ts'
import type { Delivery } from '../../../lib/rules.ts'
import PayForm from '../../../components/PayForm.tsx'
import { applyOptions, pay } from '../actions.ts'
import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default async function Checkout({ params, searchParams }: { params: Promise<{ holdId: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const holdId = Number((await params).holdId)
  const { error, notice } = await searchParams
  const session = await getSession()
  const hold = session && Number.isInteger(holdId) ? liveHold(holdId, session.token) : undefined
  if (!hold) {
    return (
      <>
        <h1>Checkout</h1>
        {error && <p className="error">{error}</p>}
        <p>Your hold has expired or was released. <Link href="/">Find tickets again</Link></p>
      </>
    )
  }
  const ev = db.prepare('SELECT e.title, e.slug, e.starts_at, v.name AS venue, v.tz, c.country FROM events e JOIN venues v ON v.id = e.venue_id JOIN cities c ON c.id = v.city_id WHERE e.id = ?').get(hold.event_id) as {
    title: string; slug: string; starts_at: string; venue: string; tz: string; country: string
  }
  const cur = displayCurrency(await currencyPref(), ev.country)
  const q = quote(hold.id)
  const resale = q.lines.some((l) => l.listingId)
  const offers = resale ? [] : (db.prepare('SELECT id, name, pct_off FROM offers WHERE event_id = ? AND pct_off > 0 ORDER BY pct_off').all(hold.event_id) as { id: number; name: string; pct_off: number }[])
  const addons = resale ? [] : (db.prepare('SELECT id, kind, name, price_cents, inventory - sold AS left FROM addons WHERE event_id = ? ORDER BY id').all(hold.event_id) as { id: number; kind: string; name: string; price_cents: number; left: number }[])
  const opts = parseOptions((db.prepare('SELECT options FROM holds WHERE id = ?').get(hold.id) as { options: string | null }).options)
  const user = await getUser()
  const face = q.lines.reduce((n, l) => n + (l.eventId === hold.event_id ? l.unit : 0), 0)
  const premium = resale ? 0 : Math.round(((face - q.discount) * protectionPct()) / 100)
  const flags = db.prepare('SELECT print_ok, willcall_ok FROM events WHERE id = ?').get(hold.event_id) as { print_ok: number; willcall_ok: number }
  const deliveries = (['mobile', ...(flags.print_ok ? ['print'] : []), ...(flags.willcall_ok ? ['willcall'] : [])] as Delivery[]).filter((d) => !resale || d === 'mobile').map((d) => [d, DELIVERY_LABEL[d]] as [string, string])
  const cards = user ? listSavedCards(user.id) : []
  const addr = user ? addressOf((db.prepare('SELECT address FROM users WHERE id = ?').get(user.id) as { address: string | null }).address) : undefined
  const prefill = user && addr?.line1 && addr.city && addr.zip ? { bname: user.name, baddress: addr.line1, bcity: addr.city, bzip: addr.zip } : undefined
  const express = !!prefill && !!prefill.bname && cards.length > 0 && !session?.impersonator_id
  const limited = db
    .prepare('SELECT s.name AS section, st.row, st.number FROM inventory i JOIN seats st ON st.id = i.seat_id JOIN sections s ON s.id = i.section_id WHERE i.hold_id = ? AND st.obstructed = 1 ORDER BY i.id')
    .all(hold.id) as { section: string; row: string; number: number }[]
  if (!resale && premium > 0 && opts.protection === undefined && !error && !notice) redirect(`/checkout/${hold.id}/protection`)
  const parts = user ? plan(q.total, ev.starts_at) : null // pay in 4 is for accounts only
  return (
    <>
      <h1>Checkout</h1>
      {cur !== 'USD' && <p className="muted">Your card is charged in USD ({money(q.total)}). {cur} amounts use a fixed demo rate and are approximate.</p>}
      <div className="card">
        <strong>{ev.title}</strong>
        <div className="muted">{ev.venue} · {fmtDateTimeTz(ev.starts_at, ev.tz)}</div>
        <ul>
          {q.lines.map((l) => (
            <li key={l.inventoryId}>{l.label}{l.offer ? ` · ${l.offer}` : ''} · {money(l.unit)} + {money(l.fee)} fees + {money(l.tax)} tax = <strong>{money(l.unit + l.fee + l.tax)}</strong> all-in</li>
          ))}
          {q.addons.map((a) => <li key={a.addonId}>{a.qty} × {a.name} · {money(a.unit)} each</li>)}
        </ul>
        <table>
          <tbody>
            <tr><td>Tickets{q.addons.length ? ' and add-ons' : ''}</td><td>{money(q.subtotal)}</td></tr>
            <tr><td>Service and facility fees</td><td>{money(q.fees - q.orderFee)}</td></tr>
            <tr><td>Order processing and delivery</td><td>{money(q.orderFee)}</td></tr>
            <tr><td>{ev.country === 'US' ? 'Tax' : 'Local tax (VAT/GST/HST, international)'}</td><td>{money(q.tax)}</td></tr>
            {q.discount > 0 && <tr><td>Promo {q.promo?.code}</td><td>-{money(q.discount)}</td></tr>}
            {q.protection > 0 && <tr><td>Ticket protection (not taxed)</td><td>{money(q.protection)}</td></tr>}
            <tr><td><strong>Total</strong></td><td><strong>{money(q.total)}</strong></td></tr>
            {cur !== 'USD' && <tr><td className="muted">In {cur} (approximate)</td><td className="muted">{approx(q.total, cur)}</td></tr>}
          </tbody>
        </table>
      </div>
      {limited.length > 0 && (
        <p className="notice-banner card" role="note"><strong>Limited view:</strong> {limited.map((l) => `Section ${l.section} Row ${l.row} Seat ${l.number}`).join(', ')} {limited.length === 1 ? 'has' : 'have'} a pillar or rail in the sightline. Check the view from the seat on the seat map before you pay.</p>
      )}
      {!resale && (
        <form action={applyOptions} className="card stack">
          <input type="hidden" name="holdId" value={hold.id} />
          <label>Promo code <input name="promo" defaultValue={opts.promo ?? ''} placeholder="e.g. STORM10" autoComplete="off" /></label>
          {offers.length > 0 && q.lines.filter((l) => l.eventId === hold.event_id).map((l) => (
            <label key={l.inventoryId}>{l.label}
              <select name={`offer-${l.inventoryId}`} defaultValue={l.offerId ?? 0}>
                <option value={0}>Standard</option>
                {offers.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.pct_off}% off)</option>)}
              </select>
            </label>
          ))}
          {addons.map((a) => (
            <label key={a.id}>{a.name} {money(a.price_cents)} {a.left ? <span className="muted">({a.left} left)</span> : <strong>Sold out</strong>}
              <input name={`addon-${a.id}`} type="number" min={0} max={Math.min(a.left, 8)} defaultValue={Math.min(opts.addons?.[a.id] ?? 0, a.left)} disabled={!a.left} />
            </label>
          ))}
          {premium > 0 && <label><input type="checkbox" name="protection" defaultChecked={!!opts.protection} /> Add ticket protection: {protectionPct()}% of the tickets ({money(premium)}), not taxed. Lets you claim a refund if you cannot go.</label>}
          <button>Update order</button>
        </form>
      )}
      {notice && <p className="notice">{notice}</p>}
      {q.promoError && <p className="error">{q.promoError}. Clear the promo code and update the order to continue.</p>}
      {error && <p className="error">{error}</p>}
      <PayForm action={pay} holdId={hold.id} idemKey={randomUUID()} expiresAt={hold.expires_at} email={user?.email ?? null} saved={cards} canSave={!!user} total={money(q.total)} totalCents={q.total} installments={parts?.map((p) => money(p.amount)) ?? null} captcha={newCaptcha()} deliveries={deliveries} prefill={prefill} express={express} creditCents={user ? creditBalance(user.id) : 0} />
      <p><Link href={`/events/${ev.slug}/tickets`}>Back to seat map</Link></p>
    </>
  )
}
