import { NextResponse } from 'next/server'
import { db } from '../../../lib/db.ts'
import { SCAN_ROLES } from '../../../lib/organizer.ts'
import { attendance, scanTicket } from '../../../lib/scan.ts'
import { getUser, memberRole } from '../../../lib/session.ts'

const fail = (error: string, status: number) => NextResponse.json({ error }, { status })

// Authorise against the org that owns the EVENT, never anything the client says about orgs.
async function authorise(eventId: unknown) {
  const user = await getUser()
  if (!user) return { res: fail('Log in first', 401) }
  const ev = Number.isSafeInteger(eventId) ? (db.prepare('SELECT org_id FROM events WHERE id = ?').get(eventId as number) as { org_id: number } | undefined) : undefined
  if (!ev) return { res: fail('Event not found', 404) }
  const role = memberRole(user.id, ev.org_id)
  if (!role || !SCAN_ROLES.includes(role)) return { res: fail('Not allowed', 403) }
  return { user }
}

// { eventId, token, at? } -> { result: valid|used|expired|invalid|wrong_event, message }
export async function POST(req: Request) {
  if (!req.headers.get('content-type')?.startsWith('application/json')) return fail('Expected JSON', 415)
  const b = await req.json().catch(() => null)
  const a = await authorise(b?.eventId)
  if (a.res) return a.res
  if (typeof b.token !== 'string' || b.token.length > 200) return fail('token required', 400)
  const at = typeof b.at === 'number' && Number.isFinite(b.at) ? b.at : undefined
  return NextResponse.json(scanTicket(b.eventId, b.token.trim(), a.user!.id, at), { headers: { 'Cache-Control': 'no-store' } })
}

export async function GET(req: Request) {
  const eventId = Number(new URL(req.url).searchParams.get('eventId'))
  const a = await authorise(eventId)
  if (a.res) return a.res
  return NextResponse.json(attendance(eventId), { headers: { 'Cache-Control': 'no-store' } })
}
