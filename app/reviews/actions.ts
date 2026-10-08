'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { allowed, clientIp } from '../../lib/defense.ts'
import { UserError } from '../../lib/platform.ts'
import { submitReview } from '../../lib/reviews.ts'
import type { Target } from '../../lib/reviews.ts'
import { requireSelf } from '../../lib/session.ts'

const field = (f: FormData, k: string) => String(f.get(k) ?? '').trim()

export async function reviewAction(f: FormData) {
  const user = await requireSelf()
  const kind: Target = field(f, 'kind') === 'venue' ? 'venue' : 'event'
  const back = field(f, 'back').startsWith('/') && !field(f, 'back').startsWith('//') ? field(f, 'back') : '/'
  const to = (key: string, msg: string) => redirect(`${back}${back.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(msg)}`)
  if (!allowed('review', clientIp(await headers()), user.id, 5)) to('error', 'Too many attempts, wait a minute')
  try {
    submitReview(user.id, kind, Number(field(f, 'refId')), Number(field(f, 'rating')), field(f, 'body'))
  } catch (e) {
    if (e instanceof UserError) to('error', e.message)
    throw e
  }
  to('notice', 'Thanks! Your review will appear after a moderator approves it.')
}
