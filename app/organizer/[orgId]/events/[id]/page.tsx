import Link from 'next/link'
import Flash from '../../../../../components/Flash.tsx'
import { db } from '../../../../../lib/db.ts'
import { CATEGORIES, eventInfo } from '../../../../../lib/events.ts'
import { fmtDateTimeTz, toLocalInput } from '../../../../../lib/format.ts'
import { attendance } from '../../../../../lib/scan.ts'
import { loadEvent } from '../../../guard.ts'
import { resaleRule, transferRule } from '../../../../../lib/rules.ts'
import { cancelEvent, changeDate, publish, saveDeliveryRulesAction, saveEvent, saveInfo, saveResaleRuleAction, saveTransferRuleAction } from '../../../actions.ts'

export const dynamic = 'force-dynamic'

export default async function ManageEvent({ params, searchParams }: { params: Promise<{ orgId: string; id: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const { orgId, id } = await params
  const { e } = await loadEvent(orgId, id)
  const info = eventInfo((db.prepare('SELECT info FROM events WHERE id = ?').get(e.id) as { info: string | null }).info)
  const base = `/organizer/${orgId}/events/${e.id}`
  const draft = e.status === 'draft'
  const live = ['published', 'postponed', 'rescheduled'].includes(e.status)
  const venues = db.prepare('SELECT id, name FROM venues WHERE org_id = ? ORDER BY name').all(e.org_id) as { id: number; name: string }[]
  const stats = db
    .prepare("SELECT count(*) AS orders, coalesce(sum(total), 0) AS gross, coalesce(sum(refund_error IS NOT NULL), 0) AS failed FROM orders WHERE event_id = ? AND status IN ('paid','review','refunded','cancelled')")
    .get(e.id) as { orders: number; gross: number; failed: number }
  const att = attendance(e.id)
  const ev = db.prepare('SELECT print_ok, willcall_ok, non_transferable FROM events WHERE id = ?').get(e.id) as { print_ok: number; willcall_ok: number; non_transferable: number }
  const tr = transferRule(e.id)
  const rr = resaleRule(e.id)
  const hidden = <input type="hidden" name="eventId" value={e.id} />
  return (
    <>
      <h1>{e.title} <span className="badge">{e.status}</span></h1>
      <Flash {...(await searchParams)} />
      <p>{e.venue} · {fmtDateTimeTz(e.starts_at, e.tz)}{!draft && !e.approved && <> · <strong>awaiting admin approval</strong></>}</p>
      <p>
        <Link href={`${base}/pricing`}>Pricing and on-sale</Link> · <Link href={`${base}/inventory`}>Inventory</Link> · <Link href={`${base}/orders`}>Orders</Link> · <Link href={`${base}/reports`}>Reports</Link> · <Link href={`${base}/marketing`}>Marketing</Link> · <Link href={`${base}/access`}>Presales</Link> · <Link href={`${base}/queue`}>Waiting room</Link> · <Link href={`/scan/${e.id}`}>Scanner</Link> · <Link href={`/events/${e.slug}`}>Public page</Link>
      </p>
      <p className="muted">{stats.orders} orders · attendance {att.scanned}/{att.total}{stats.failed > 0 && ` · ${stats.failed} refund(s) failed (admin notified)`}</p>

      <h2>Details</h2>
      <form action={saveEvent} className="stack">
        {hidden}
        <input name="title" defaultValue={e.title} required maxLength={120} />
        <select name="category" defaultValue={e.category} aria-label="Category">{CATEGORIES.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}</select>
        <input name="genre" defaultValue={e.genre ?? ''} placeholder="Genre" />
        <select name="venueId" defaultValue={e.venue_id} disabled={!draft} aria-label="Venue">{venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
        {!draft && <input type="hidden" name="venueId" value={e.venue_id} />}
        <label>Starts ({e.tz}) <input type="datetime-local" name="startsAt" defaultValue={toLocalInput(e.starts_at, e.tz)} readOnly={!draft} required /></label>
        <label>Doors <input type="datetime-local" name="doorsAt" defaultValue={e.doors_at ? toLocalInput(e.doors_at, e.tz) : ''} /></label>
        <input name="image" defaultValue={e.image ?? ''} placeholder="Image URL" />
        <textarea name="description" defaultValue={e.description ?? ''} rows={4} />
        <button>Save</button>
      </form>

      <h2>Event page details</h2>
      <form action={saveInfo} className="stack">
        {hidden}
        <input name="age" defaultValue={info.age ?? ''} placeholder="Age limit (e.g. All ages, 18+)" maxLength={60} />
        <input name="bag" defaultValue={info.bag ?? ''} placeholder="Bag policy" maxLength={200} />
        <textarea name="notices" defaultValue={info.notices ?? ''} rows={2} maxLength={500} placeholder="Notice banner (parking, gate changes...)" />
        <textarea name="setTimes" defaultValue={(info.set_times ?? []).map((t) => `${t.time} ${t.act}`).join('\n')} rows={3} placeholder={'One per line, venue time: 20:30 Headliner'} />
        <button>Save details</button>
      </form>

      <h2>Delivery and ticket restrictions</h2>
      <form action={saveDeliveryRulesAction} className="stack">
        {hidden}
        <label><input type="checkbox" name="print_ok" defaultChecked={!!ev.print_ok} /> Allow print-at-home (otherwise mobile tickets only)</label>
        <label><input type="checkbox" name="willcall_ok" defaultChecked={!!ev.willcall_ok} /> Offer will-call (box-office pickup)</label>
        <label><input type="checkbox" name="non_transferable" defaultChecked={!!ev.non_transferable} /> Non-transferable: tickets cannot be sent or resold</label>
        <button>Save delivery rules</button>
      </form>

      <h2>Transfer and resale rules</h2>
      <form action={saveTransferRuleAction} className="stack">
        {hidden}
        <label><input type="checkbox" name="enabled" defaultChecked={tr.enabled} /> Allow ticket transfers</label>
        <label>Transfers close (hours before the show, blank = until the show) <input name="hours" type="number" min="1" defaultValue={tr.deadline_hours ?? ''} /></label>
        <button>Save transfer rule</button>
      </form>
      <form action={saveResaleRuleAction} className="stack">
        {hidden}
        <label><input type="checkbox" name="enabled" defaultChecked={rr.enabled} /> Allow resale</label>
        <label>Floor % of face value <input name="min_pct" type="number" min="0" max="1000" defaultValue={rr.min_pct} /></label>
        <label>Ceiling % of face value <input name="max_pct" type="number" min="1" max="1000" defaultValue={rr.max_pct} /></label>
        <label>Seller fee % <input name="seller_fee_pct" type="number" min="0" max="50" defaultValue={rr.seller_fee_pct} /></label>
        <label>Buyer fee % <input name="buyer_fee_pct" type="number" min="0" max="50" defaultValue={rr.buyer_fee_pct} /></label>
        <label><input type="checkbox" name="inherit" /> Use the platform defaults instead</label>
        <button>Save resale rule</button>
      </form>

      {draft && (
        <form action={publish} className="stack">
          {hidden}
          <button>Publish</button>
        </form>
      )}
      {live && (
        <>
          <h2>Date changes</h2>
          <p className="muted">Tickets stay valid; every holder is emailed.</p>
          <form action={changeDate} className="stack">
            {hidden}
            <input type="hidden" name="kind" value="rescheduled" />
            <label>New start ({e.tz}) <input type="datetime-local" name="startsAt" required /></label>
            <button>Reschedule</button>
          </form>
          {e.status !== 'postponed' && (
            <form action={changeDate} className="stack">
              {hidden}
              <input type="hidden" name="kind" value="postponed" />
              <button>Postpone (date to be announced)</button>
            </form>
          )}
        </>
      )}
      {(live || e.status === 'cancelled') && (
        <>
          <h2>{e.status === 'cancelled' ? 'Retry refunds' : 'Cancel event'}</h2>
          <form action={cancelEvent} className="stack">
            {hidden}
            <button>{e.status === 'cancelled' ? 'Retry failed refunds' : 'Cancel event and refund every order'}</button>
          </form>
        </>
      )}
    </>
  )
}
