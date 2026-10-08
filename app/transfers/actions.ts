'use server'

import { redirect } from 'next/navigation'
import { HoldError } from '../../lib/inventory.ts'
import { acceptTransfer, cancelTransfer, createTransfer, declineTransfer } from '../../lib/transfers.ts'
import { requireUser } from '../../lib/session.ts'

const field = (f: FormData, k: string) => String(f.get(k) ?? '').trim()
const id = (f: FormData, k: string) => (/^\d+$/.test(field(f, k)) ? Number(field(f, k)) : 0)
const go = (path: string, key: 'error' | 'notice', msg: string): never => redirect(`${path}${path.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(msg)}`)

// Run a state change; HoldError text goes back to the page as ?error=
function attempt(path: string, fn: () => void) {
  try {
    fn()
  } catch (e) {
    if (e instanceof HoldError) go(path, 'error', e.message)
    throw e
  }
}

export async function sendTransfer(f: FormData) {
  const user = await requireUser()
  const ticket = id(f, 'ticketId')
  const back = `/tickets/${ticket}`
  attempt(back, () => createTransfer(user.id, ticket, field(f, 'to')))
  go(back, 'notice', 'Transfer sent. You can cancel it until it is accepted.')
}

export async function cancelTransferAction(f: FormData) {
  const user = await requireUser()
  const back = field(f, 'back').startsWith('/') && !field(f, 'back').startsWith('//') ? field(f, 'back') : '/tickets'
  attempt(back, () => cancelTransfer(user.id, id(f, 'transferId')))
  go(back, 'notice', 'Transfer cancelled.')
}

export async function acceptTransferAction(f: FormData) {
  const user = await requireUser()
  const tid = id(f, 'transferId')
  const back = `/transfers/${tid}?token=${encodeURIComponent(field(f, 'token'))}`
  let ticket = 0
  attempt(back, () => (ticket = acceptTransfer(user.id, tid, field(f, 'token'))))
  redirect(`/tickets/${ticket}`)
}

export async function declineTransferAction(f: FormData) {
  await requireUser()
  const tid = id(f, 'transferId')
  const back = `/transfers/${tid}?token=${encodeURIComponent(field(f, 'token'))}`
  attempt(back, () => declineTransfer(tid, field(f, 'token')))
  redirect(back)
}
