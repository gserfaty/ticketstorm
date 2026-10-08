import { notFound } from 'next/navigation'
import { db } from '../../lib/db.ts'
import { MANAGE_ROLES } from '../../lib/organizer.ts'
import { requireOrgRole } from '../../lib/session.ts'

export type OrgEvent = { id: number; org_id: number; venue_id: number; slug: string; title: string; category: string; genre: string | null; starts_at: string; doors_at: string | null; image: string | null; description: string | null; status: string; onsale_at: string | null; fee_rule: string | null; approved: number; tz: string; venue: string }

// Page-level scoping. The URL's orgId must equal the event's real org (else 404), then the viewer's role is checked against the event's org.
export async function loadEvent(orgId: string, eventId: string, roles = MANAGE_ROLES) {
  const e = db
    .prepare('SELECT e.*, v.tz, v.name AS venue FROM events e JOIN venues v ON v.id = e.venue_id WHERE e.id = ?')
    .get(Number(eventId)) as OrgEvent | undefined
  if (!e || e.org_id !== Number(orgId)) notFound()
  const { user, role } = await requireOrgRole(e!.org_id, roles)
  return { e: e!, user, role }
}
