import Link from 'next/link'
import Flash from '../../../../../components/Flash.tsx'
import { db } from '../../../../../lib/db.ts'
import { CATEGORIES } from '../../../../../lib/events.ts'
import { fmtDateTimeTz, toLocalInput } from '../../../../../lib/format.ts'
import { attendance } from '../../../../../lib/scan.ts'
import { loadEvent } from '../../../guard.ts'
import { cancelEvent, changeDate, publish, saveEvent } from '../../../actions.ts'

export const dynamic = 'force-dynamic'

export default async function ManageEvent({ params, searchParams }: { params: Promise<{ orgId: string; id: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const { orgId, id } = await params
  const { e } = await loadEvent(orgId, id)
  const base = `/organizer/${orgId}/events/${e.id}`
  const draft = e.status === 'draft'
  const live = ['published', 'postponed', 'rescheduled'].includes(e.status)
  const venues = db.prepare('SELECT id, name FROM venues WHERE org_id = ? ORDER BY name').all(e.org_id) as { id: number; name: string }[]
  const stats = db
    .prepare("SELECT count(*) AS orders, coalesce(sum(total), 0) AS gross, coalesce(sum(refund_error IS NOT NULL), 0) AS failed FROM orders WHERE event_id = ? AND status IN ('paid','review','refunded','cancelled')")
    .get(e.id) as { orders: number; gross: number; failed: number }
  const att = attendance(e.id)
  const hidden = <input type="hidden" name="eventId" value={e.id} />
  return (
    <>
      <h1>{e.title} <span className="badge">{e.status}</span></h1>
      <Flash {...(await searchParams)} />
      <p>{e.venue} · {fmtDateTimeTz(e.starts_at, e.tz)}{!draft && !e.approved && <> · <strong>awaiting admin approval</strong></>}</p>
      <p>
        <Link href={`${base}/pricing`}>Pricing and on-sale</Link> · <Link href={`${base}/inventory`}>Inventory</Link> · <Link href={`${base}/access`}>Presales</Link> · <Link href={`${base}/queue`}>Waiting room</Link> · <Link href={`/scan/${e.id}`}>Scanner</Link> · <Link href={`/events/${e.slug}`}>Public page</Link>
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
