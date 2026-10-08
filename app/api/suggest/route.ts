import { NextResponse } from 'next/server'
import { suggest } from '../../../lib/events.ts'

export function GET(req: Request) {
  const q = (new URL(req.url).searchParams.get('q') ?? '').trim().slice(0, 100)
  return NextResponse.json(q.length < 2 ? { artists: [], events: [], venues: [] } : suggest(q))
}
