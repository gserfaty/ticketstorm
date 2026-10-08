'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { allowed, clientIp } from '../../lib/defense.ts'
import { findGift, purchaseGift, redeemToCredit } from '../../lib/giftcards.ts'
import { money } from '../../lib/format.ts'
import { UserError } from '../../lib/platform.ts'
import { getUser, requireSelf } from '../../lib/session.ts'

const field = (f: FormData, k: string) => String(f.get(k) ?? '').trim()
const go = (key: 'error' | 'notice', msg: string): never => redirect(`/gift-cards?${key}=${encodeURIComponent(msg)}`)

// Buying spends the buyer's card: an account, and not while impersonating (requireSelf).
export async function buyGiftCard(f: FormData) {
  const user = await requireSelf()
  if (!allowed('giftbuy', clientIp(await headers()), user.id, 5)) go('error', 'Too many attempts, wait a minute')
  const dollars = field(f, 'amount')
  try {
    purchaseGift(user.id, {
      amount: /^\d{1,4}(\.\d{1,2})?$/.test(dollars) ? Math.round(Number(dollars) * 100) : 0, recipient: field(f, 'recipient').toLowerCase(), message: field(f, 'message'),
      number: field(f, 'number').replace(/[\s-]/g, ''), exp: field(f, 'exp'), cvc: field(f, 'cvc'),
    })
  } catch (e) {
    if (e instanceof UserError) go('error', e.message)
    throw e
  }
  go('notice', `Gift card sent to ${field(f, 'recipient')}. The code is in the email (Dev outbox).`)
}

// Balance checks are rate-limited per IP and per account, and a wrong code says the same thing as an empty one.
export async function checkBalance(f: FormData) {
  const user = await getUser()
  if (!allowed('giftcheck', clientIp(await headers()), user?.id ?? null, 10)) go('error', 'Too many attempts, wait a minute')
  const g = findGift(field(f, 'code'))
  if (!g) go('error', 'That gift card code is not valid')
  go('notice', `Gift card ending ${g!.last4} has ${money(g!.balance)} left.`)
}

export async function redeemGiftCard(f: FormData) {
  const user = await requireSelf()
  if (!allowed('giftcheck', clientIp(await headers()), user.id, 10)) go('error', 'Too many attempts, wait a minute')
  try {
    const cents = redeemToCredit(user.id, field(f, 'code'))
    go('notice', `${money(cents)} was added to your account credit.`)
  } catch (e) {
    if (e instanceof UserError) go('error', e.message)
    throw e
  }
}
