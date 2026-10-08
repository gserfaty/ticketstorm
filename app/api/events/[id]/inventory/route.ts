import { NextResponse } from 'next/server'
import { db } from '../../../../../lib/db.ts'
import { openWindowIds } from '../../../../../lib/access.ts'
import { getAvailability } from '../../../../../lib/inventory.ts'
import { getSession } from '../../../../../lib/session.ts'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id)
  if (!Number.isSafeInteger(id) || !db.prepare("SELECT 1 FROM events WHERE id = ? AND status != 'draft' AND approved = 1").get(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(getAvailability(id, openWindowIds(id, (await getSession())?.token)), { headers: { 'Cache-Control': 'no-store' } })
}
