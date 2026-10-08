import Flash from '../../../../../components/Flash.tsx'
import { db } from '../../../../../lib/db.ts'
import { CATEGORIES } from '../../../../../lib/events.ts'
import { MANAGE_ROLES } from '../../../../../lib/organizer.ts'
import { requireOrgRole } from '../../../../../lib/session.ts'
import { createEventAction } from '../../../actions.ts'

export const dynamic = 'force-dynamic'

export default async function NewEvent({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ error?: string }> }) {
  const orgId = Number((await params).orgId)
  await requireOrgRole(orgId, MANAGE_ROLES)
  const venues = db.prepare('SELECT id, name, tz FROM venues WHERE org_id = ? ORDER BY name').all(orgId) as { id: number; name: string; tz: string }[]
  return (
    <>
      <h1>New event</h1>
      <Flash error={(await searchParams).error} />
      {!venues.length ? <p>Add a venue first.</p> : (
        <form action={createEventAction} className="stack">
          <input type="hidden" name="orgId" value={orgId} />
          <input name="title" placeholder="Title" required maxLength={120} />
          <select name="category" aria-label="Category">{CATEGORIES.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}</select>
          <input name="genre" placeholder="Genre (optional)" />
          <select name="venueId" aria-label="Venue">{venues.map((v) => <option key={v.id} value={v.id}>{v.name} ({v.tz})</option>)}</select>
          <label>Starts (venue time) <input type="datetime-local" name="startsAt" required /></label>
          <label>Doors (venue time) <input type="datetime-local" name="doorsAt" /></label>
          <input name="image" placeholder="Image URL (optional)" />
          <textarea name="description" placeholder="Description" rows={4} />
          <button>Create draft</button>
        </form>
      )}
    </>
  )
}
