'use server'

import { redirect } from 'next/navigation'
import { UserError } from '../../lib/platform.ts'
import { addMessage } from '../../lib/support.ts'
import { requireUser } from '../../lib/session.ts'

export async function replyToSupport(f: FormData) {
  const user = await requireUser()
  const id = Number(f.get('ticketId'))
  try {
    addMessage(id, { staff: false, userId: user.id }, String(f.get('message') ?? ''))
  } catch (e) {
    if (e instanceof UserError) redirect(`/support/${id}?error=${encodeURIComponent(e.message)}`)
    throw e
  }
  redirect(`/support/${id}?notice=Sent`)
}
