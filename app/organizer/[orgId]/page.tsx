import Link from 'next/link'
import { notFound } from 'next/navigation'
import Flash from '../../../components/Flash.tsx'
import { db } from '../../../lib/db.ts'
import { fmtDateTime } from '../../../lib/format.ts'
import { ALL_ROLES, MANAGE_ROLES, SCAN_ROLES } from '../../../lib/organizer.ts'
import { requireOrgRole } from '../../../lib/session.ts'
import { createVenueAction } from '../actions.ts'

export const dynamic = 'force-dynamic'

export default async function OrgHome({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const orgId = Number((await params).orgId)
  const { role } = await requireOrgRole(orgId, ALL_ROLES)
  const org = db.prepare('SELECT id, name, status FROM orgs WHERE id = ?').get(orgId) as { id: number; name: string; status: string } | undefined
  if (!org) notFound()
  const manage = MANAGE_ROLES.includes(role)
  const events = db
    .prepare('SELECT e.id, e.title, e.status, e.approved, e.starts_at, v.tz FROM events e JOIN venues v ON v.id = e.venue_id WHERE e.org_id = ? ORDER BY e.starts_at DESC LIMIT 100')
    .all(orgId) as { id: number; title: string; status: string; approved: number; starts_at: string; tz: string }[]
  const venues = db.prepare('SELECT id, name FROM venues WHERE org_id = ? ORDER BY name').all(orgId) as { id: number; name: string }[]
  const cities = db.prepare('SELECT id, name, state FROM cities ORDER BY name').all() as { id: number; name: string; state: string }[]
  const sp = await searchParams
  return (
    <>
      <h1>{org!.name} <span className="badge">{org!.status}</span></h1>
      <Flash {...sp} />
      {org!.status !== 'approved' && <p className="muted">Pending admin approval: you can prepare drafts but not publish.</p>}
      <p>
        {manage && <><Link href={`/organizer/${orgId}/events/new`}>New event</Link> · <Link href={`/organizer/${orgId}/members`}>Members</Link></>}
      </p>
      <h2>Events</h2>
      {events.map((e) => (
        <div className="card" key={e.id}>
          {e.title} <span className="badge">{e.status}{e.status !== 'draft' && !e.approved ? ' · awaiting approval' : ''}</span> <span className="muted">{fmtDateTime(e.starts_at, e.tz)}</span>{' '}
          {manage && <Link href={`/organizer/${orgId}/events/${e.id}`}>Manage</Link>}{' '}
          {SCAN_ROLES.includes(role) && <Link href={`/scan/${e.id}`}>Scan</Link>}
        </div>
      ))}
      {!events.length && <p className="muted">No events yet.</p>}
      {manage && (
        <>
          <h2>Venues</h2>
          <ul>{venues.map((v) => <li key={v.id}>{v.name} · <Link href={`/organizer/${orgId}/venues/${v.id}/chart`}>Seating chart</Link></li>)}</ul>
          <form action={createVenueAction} className="stack">
            <input type="hidden" name="orgId" value={orgId} />
            <input name="name" placeholder="Venue name" required />
            <input name="address" placeholder="Address" required />
            <select name="cityId" aria-label="City">{cities.map((c) => <option key={c.id} value={c.id}>{c.name}, {c.state}</option>)}</select>
            <input name="tz" placeholder="Time zone, e.g. America/Chicago" defaultValue="America/New_York" required />
            <select name="kind" aria-label="Layout"><option>arena</option><option>stadium</option><option>theater</option><option>amphitheater</option><option>club</option></select>
            <button>Add venue</button>
          </form>
        </>
      )}
    </>
  )
}
