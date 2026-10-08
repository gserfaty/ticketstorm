import { NextResponse } from 'next/server'
import { releaseHold } from '../../../../lib/inventory.ts'
import { getSession } from '../../../../lib/session.ts'

// 404 for both "no such hold" and "not your hold".
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id)
  const session = await getSession()
  if (!session || !Number.isSafeInteger(id) || !releaseHold(id, session.token)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
