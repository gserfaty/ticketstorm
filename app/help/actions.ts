'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { allowed, clientIp } from '../../lib/defense.ts'
import { UserError } from '../../lib/platform.ts'
import { createContact } from '../../lib/support.ts'
import { getUser } from '../../lib/session.ts'

const field = (f: FormData, k: string) => String(f.get(k) ?? '').trim()

export async function submitContact(f: FormData) {
  const user = await getUser()
  if (field(f, 'website')) redirect('/help') // honeypot
  if (!allowed('contact', clientIp(await headers()), user?.id ?? null, 5)) redirect(`/help?error=${encodeURIComponent('Too many requests, try again in a minute')}#contact`)
  let id: number
  try {
    id = createContact(user?.id ?? null, user?.email ?? field(f, 'email'), field(f, 'subject'), String(f.get('message') ?? '').trim())
  } catch (e) {
    if (e instanceof UserError) redirect(`/help?error=${encodeURIComponent(e.message)}#contact`)
    throw e
  }
  redirect(`/help?notice=${encodeURIComponent(`Ticket #${id} received. We reply by email${user ? ' and on your support page' : ''}.`)}#contact`)
}
