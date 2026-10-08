'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { db } from '../../lib/db.ts'
import { redeemCode, registerVf } from '../../lib/access.ts'
import { allowed, clientIp, isBlocked } from '../../lib/defense.ts'
import { UserError } from '../../lib/platform.ts'
import { ensureSession, getUser } from '../../lib/session.ts'

const field = (f: FormData, k: string) => String(f.get(k) ?? '').trim()

// Back to the event page (slug looked up by id, never taken from the form).
function eventPath(f: FormData) {
  const e = db.prepare('SELECT id, slug FROM events WHERE id = ?').get(Number(field(f, 'eventId'))) as { id: number; slug: string } | undefined
  if (!e) redirect('/')
  return { id: e!.id, path: `/events/${e!.slug}` }
}
const go = (path: string, key: 'error' | 'notice', msg: string): never => redirect(`${path}?${key}=${encodeURIComponent(msg)}`)

async function guard(path: string) {
  const user = await getUser()
  const ip = clientIp(await headers())
  if (isBlocked(ip, user?.email)) go(path, 'error', 'Access denied')
  if (!allowed('access', ip, user?.id ?? null, 10)) go(path, 'error', 'Too many attempts, wait a minute')
  return user
}

export async function unlockPresale(f: FormData) {
  const { id, path } = eventPath(f)
  const user = await guard(path)
  const token = await ensureSession()
  try {
    redeemCode(id, token, user?.id ?? null, field(f, 'code'))
  } catch (e) {
    if (e instanceof UserError) go(path, 'error', e.message)
    throw e
  }
  go(path, 'notice', 'Presale unlocked. Find tickets below.')
}

export async function registerVerifiedFan(f: FormData) {
  const { path } = eventPath(f)
  const user = await guard(path)
  if (!user) redirect(`/login?next=${encodeURIComponent(path)}`)
  try {
    registerVf(Number(field(f, 'windowId')), user!.id)
  } catch (e) {
    if (e instanceof UserError) go(path, 'error', e.message)
    throw e
  }
  go(path, 'notice', "You're registered. If you're selected, we'll email and text you a code.")
}
