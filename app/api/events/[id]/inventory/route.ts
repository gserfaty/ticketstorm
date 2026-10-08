import { NextResponse } from 'next/server'
import { getAvailability } from '../../../../../lib/inventory.ts'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id)
  if (!Number.isSafeInteger(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(getAvailability(id), { headers: { 'Cache-Control': 'no-store' } })
}
