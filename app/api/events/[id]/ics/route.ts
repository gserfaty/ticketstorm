import { NextResponse } from 'next/server'
import { db } from '../../../../../lib/db.ts'
import { buildIcs } from '../../../../../lib/ics.ts'
import type { IcsEvent } from '../../../../../lib/ics.ts'
import { APP_URL } from '../../../../../lib/notify.ts'

// Calendar file for a public event (not a draft, not awaiting approval).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id)
  const e = Number.isSafeInteger(id)
    ? (db
        .prepare(
          `SELECT e.id, e.slug, e.title, e.starts_at, e.status, e.description, v.name AS venue, v.address, c.name AS city, c.state
           FROM events e JOIN venues v ON v.id = e.venue_id JOIN cities c ON c.id = v.city_id WHERE e.id = ? AND e.status != 'draft' AND e.approved = 1`,
        )
        .get(id) as (IcsEvent & { slug: string }) | undefined)
    : undefined
  if (!e) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return new NextResponse(buildIcs(e, `${APP_URL}/events/${e.slug}`), {
    headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="event-${e.id}.ics"` },
  })
}
