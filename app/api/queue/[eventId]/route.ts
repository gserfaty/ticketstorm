import { NextResponse } from 'next/server'
import { db } from '../../../../lib/db.ts'
import { allowed, checkCaptcha, clientIp, isBlocked, newCaptcha } from '../../../../lib/defense.ts'
import { joinQueue, queueStatus } from '../../../../lib/queue.ts'
import { UserError } from '../../../../lib/platform.ts'
import { ensureSession, getSession } from '../../../../lib/session.ts'

const noStore = { 'Cache-Control': 'no-store' }
const eventId = async (p: Promise<{ eventId: string }>) => Number((await p).eventId)

// Poll: this session's place in line (position, wait estimate) or admission.
export async function GET(_req: Request, { params }: { params: Promise<{ eventId: string }> }) {
  const id = await eventId(params)
  const s = await getSession()
  if (!Number.isSafeInteger(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(s ? queueStatus(id, s.token) : { state: 'none' }, { headers: noStore })
}

// Join: { answer, token, website }. Every refusal carries a fresh captcha (each one is single-use).
export async function POST(req: Request, { params }: { params: Promise<{ eventId: string }> }) {
  const id = await eventId(params)
  const fail = (error: string, status: number) => NextResponse.json({ error, captcha: newCaptcha() }, { status, headers: noStore })
  if (!Number.isSafeInteger(id)) return fail('Not found', 404)
  if (!req.headers.get('content-type')?.startsWith('application/json')) return fail('Expected JSON', 415)
  const b = await req.json().catch(() => null)
  const ip = clientIp(req.headers)
  const s = await getSession()
  const email = s?.user_id ? (db.prepare('SELECT email FROM users WHERE id = ?').get(s.user_id) as { email: string }).email : null
  if (isBlocked(ip, email)) return fail('Access denied', 403)
  if (!allowed('queue-join', ip, s?.user_id ?? null, 5)) return fail('Too many attempts, wait a minute', 429)
  if (b?.website) return fail('Rejected', 400) // honeypot: real users never see this field
  if (!checkCaptcha(String(b?.token ?? ''), String(b?.answer ?? ''))) return fail('Wrong answer, try the new question', 400)
  const token = await ensureSession()
  try {
    joinQueue(id, token, s?.user_id ?? null)
  } catch (e) {
    if (e instanceof UserError) return fail(e.message, 400)
    throw e
  }
  return NextResponse.json(queueStatus(id, token), { headers: noStore })
}
