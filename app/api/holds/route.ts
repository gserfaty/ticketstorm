import { NextResponse } from 'next/server'
import { db } from '../../../lib/db.ts'
import { HoldError, holdBestAvailable, holdGA, holdSeats } from '../../../lib/inventory.ts'
import { ensureSession } from '../../../lib/session.ts'

const posInt = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined)
const bad = (error: string, status = 400) => NextResponse.json({ error }, { status })

// { eventId, seatIds } | { eventId, bestAvailable: { qty, levelId?, accessible? } } | { eventId, ga: { sectionId, qty } }
export async function POST(req: Request) {
  if (!req.headers.get('content-type')?.startsWith('application/json')) return bad('Expected JSON', 415)
  const b = await req.json().catch(() => null)
  const eventId = posInt(b?.eventId)
  if (!eventId) return bad('eventId required')
  const modes = ['seatIds', 'bestAvailable', 'ga'].filter((k) => b[k] !== undefined)
  if (modes.length !== 1) return bad('Send exactly one of seatIds, bestAvailable, ga')

  const sessionToken = await ensureSession()
  const owner = {
    sessionToken,
    userId: (db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(sessionToken) as { user_id: number | null }).user_id,
  }
  try {
    let held
    if (modes[0] === 'seatIds') {
      const ids = b.seatIds
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || !ids.every((x: unknown) => posInt(x))) return bad('seatIds must be a list of ids')
      held = holdSeats(eventId, owner, ids)
    } else if (modes[0] === 'bestAvailable') {
      const { qty, levelId, accessible } = b.bestAvailable ?? {}
      if (!posInt(qty)) return bad('qty required')
      if (levelId !== undefined && !posInt(levelId)) return bad('invalid levelId')
      if (accessible !== undefined && typeof accessible !== 'boolean') return bad('invalid accessible')
      held = holdBestAvailable(eventId, owner, qty, levelId, accessible)
    } else {
      const { sectionId, qty } = b.ga ?? {}
      if (!posInt(sectionId) || !posInt(qty)) return bad('sectionId and qty required')
      held = holdGA(eventId, owner, sectionId, qty)
    }
    return NextResponse.json({ holdId: held.holdId, expiresAt: held.expiresAt, seatIds: held.ids })
  } catch (e) {
    if (e instanceof HoldError) return bad(e.message, e.status)
    throw e
  }
}
