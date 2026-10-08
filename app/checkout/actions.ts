'use server'

import { redirect } from 'next/navigation'
import { db } from '../../lib/db.ts'
import { HoldError } from '../../lib/inventory.ts'
import { approve3ds, fail3ds, finalize } from '../../lib/orders.ts'
import { brandOf, validateCard } from '../../lib/payments.ts'
import { getSession, getUser } from '../../lib/session.ts'

const field = (f: FormData, k: string) => String(f.get(k) ?? '').trim()
const back = (holdId: number, msg: string): never => redirect(`/checkout/${holdId}?error=${encodeURIComponent(msg)}`)
const DECLINES: Record<string, string> = {
  card_declined: 'Your card was declined. Try another card.',
  insufficient_funds: 'Insufficient funds. Try another card.',
  '3ds_failed': 'Authentication failed. Try again or use another card.',
  hold_expired: 'Your hold expired.',
}

export async function pay(f: FormData) {
  const session = await getSession()
  const holdId = Number(field(f, 'holdId'))
  if (!session || !Number.isInteger(holdId) || holdId < 1) redirect('/')
  const key = field(f, 'key')
  if (!/^[\w-]{8,64}$/.test(key)) back(holdId, 'Invalid form, reload and try again')

  const user = await getUser()
  const email = user ? user.email : field(f, 'email').toLowerCase()
  if (!/^\S+@\S+\.\S+$/.test(email)) back(holdId, 'Enter a valid email')
  const billing = { name: field(f, 'bname'), address: field(f, 'baddress'), city: field(f, 'bcity'), zip: field(f, 'bzip') }
  if (Object.values(billing).some((v) => !v)) back(holdId, 'Fill in the billing address')

  let method: 'card' | 'saved' = 'card'
  let brand = ''
  let last4 = ''
  let exp = ''
  const savedId = field(f, 'saved')
  if (savedId) {
    const c = user && (db.prepare('SELECT brand, last4, exp FROM saved_cards WHERE id = ? AND user_id = ?').get(Number(savedId), user.id) as { brand: string; last4: string; exp: string } | undefined)
    if (!c) back(holdId, 'Saved card not found')
    method = 'saved'
    ;({ brand, last4, exp } = c!)
  } else {
    // number and cvc live only in this function's locals; only brand + last4 + exp go further
    const card = { number: field(f, 'number').replace(/[\s-]/g, ''), exp: field(f, 'exp'), cvc: field(f, 'cvc') }
    const err = validateCard(card)
    if (err) back(holdId, err)
    ;({ exp } = card)
    brand = brandOf(card.number)
    last4 = card.number.slice(-4)
  }

  let r
  try {
    r = finalize({ holdId, sessionToken: session.token, userId: user?.id ?? null, email, key, method, brand, last4, exp, save: !!user && f.get('save') === 'on', billing })
  } catch (e) {
    if (e instanceof HoldError) return back(holdId, e.message)
    throw e
  }
  if ('orderId' in r) redirect(`/orders/${r.orderId}`)
  if ('threeDs' in r) redirect(`/checkout/3ds/${r.threeDs}`)
  back(holdId, DECLINES[r.declined] ?? 'Payment declined')
}

export async function threeDs(f: FormData) {
  const session = await getSession()
  const id = Number(field(f, 'paymentId'))
  if (!session || !Number.isInteger(id)) redirect('/')
  if (field(f, 'result') === 'fail') {
    const holdId = fail3ds(id, session!.token)
    if (!holdId) redirect('/')
    back(holdId!, DECLINES['3ds_failed'])
  }
  try {
    const r = approve3ds(id, session!.token)
    if ('orderId' in r) redirect(`/orders/${r.orderId}`)
  } catch (e) {
    if (!(e instanceof HoldError)) throw e
    const h = db.prepare('SELECT hold_id FROM payments WHERE id = ? AND session_token = ?').get(id, session!.token) as { hold_id: number } | undefined
    if (!h) redirect('/')
    back(h!.hold_id, e.message)
  }
  redirect('/')
}
