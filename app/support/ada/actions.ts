'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { allowed, clientIp } from '../../../lib/defense.ts'
import { UserError } from '../../../lib/platform.ts'
import { createAdaRequest } from '../../../lib/support.ts'
import { getUser } from '../../../lib/session.ts'

const field = (f: FormData, k: string) => String(f.get(k) ?? '').trim()

export async function submitAda(f: FormData) {
  const user = await getUser()
  const ctx = `event=${encodeURIComponent(field(f, 'event'))}&venue=${encodeURIComponent(field(f, 'venue'))}`
  if (field(f, 'website')) redirect('/') // honeypot
  if (!allowed('ada', clientIp(await headers()), user?.id ?? null, 5)) redirect(`/support/ada?${ctx}&error=${encodeURIComponent('Too many requests, try again in a minute')}`)
  let id: number
  try {
    id = createAdaRequest(user?.id ?? null, { email: user?.email ?? field(f, 'email'), name: field(f, 'name'), need: field(f, 'need'), details: field(f, 'details'), event: field(f, 'event'), venue: field(f, 'venue') })
  } catch (e) {
    if (e instanceof UserError) redirect(`/support/ada?${ctx}&error=${encodeURIComponent(e.message)}`)
    throw e
  }
  redirect(`/support/ada?notice=${encodeURIComponent(`Request #${id} received. We will reply by email.`)}`)
}
