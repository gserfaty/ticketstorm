'use server'

import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { db } from '../../lib/db.ts'
import { allowed, checkCaptcha, clientIp, isBlocked, mac, newCaptcha } from '../../lib/defense.ts'
import type { Captcha } from '../../lib/defense.ts'
import { HoldError } from '../../lib/inventory.ts'
import { UserError } from '../../lib/platform.ts'
import { setCheckoutOptions } from '../../lib/pricing.ts'
import { approve3ds, fail3ds, finalize } from '../../lib/orders.ts'
import { brandOf, validateCard } from '../../lib/payments.ts'
import type { Method } from '../../lib/payments.ts'
import { getSession, getUser, refuseImpersonation } from '../../lib/session.ts'

const field = (f: FormData, k: string) => String(f.get(k) ?? '').trim()
const back = (holdId: number, msg: string): never => redirect(`/checkout/${holdId}?error=${encodeURIComponent(msg)}`)
// Form state returned to PayForm on a failed attempt: the message plus the non-card fields to refill. Never card number or CVC.
export type PayState = { error?: string; v?: Record<string, string>; captcha?: Captcha }
const DECLINES: Record<string, string> = {
  card_declined: 'Your card was declined. Try another card.',
  insufficient_funds: 'Insufficient funds. Try another card.',
  '3ds_failed': 'Authentication failed. Try again or use another card.',
  hold_expired: 'Your hold expired.',
  paypal_cancelled: 'PayPal payment cancelled.',
}

export async function pay(_: PayState, f: FormData): Promise<PayState> {
  const session = await getSession()
  if (session?.impersonator_id) return { error: 'Purchases are disabled while viewing as another user' } // would charge the target's saved card
  const holdId = Number(field(f, 'holdId'))
  if (!session || !Number.isInteger(holdId) || holdId < 1) redirect('/')
  const v = Object.fromEntries(['email', 'bname', 'baddress', 'bcity', 'bzip'].map((k) => [k, field(f, k)]))
  const bad = (error: string): PayState => ({ error, v, captcha: newCaptcha() }) // captchas are single-use: every refusal brings a new one
  const key = field(f, 'key')
  if (!/^[\w-]{8,64}$/.test(key)) return bad('Invalid form, reload and try again')

  const user = await getUser()
  const email = user ? user.email : field(f, 'email').toLowerCase()
  const ip = clientIp(await headers())
  if (isBlocked(ip, email)) return bad('We cannot process this order')
  if (!allowed('checkout', ip, user?.id ?? null, 10)) return bad('Too many attempts, wait a minute')
  if (field(f, 'website')) return bad('Invalid form, reload and try again') // honeypot
  if (!checkCaptcha(field(f, 'captchaToken'), field(f, 'captchaAnswer'))) return bad('Wrong answer to the math question')
  if (!/^\S+@\S+\.\S+$/.test(email)) return bad('Enter a valid email')
  const billing = { name: field(f, 'bname'), address: field(f, 'baddress'), city: field(f, 'bcity'), zip: field(f, 'bzip') }
  if (Object.values(billing).some((v) => !v)) return bad('Fill in the billing address')

  if (f.get('policy') !== 'on') return bad('Accept the refund policy to continue')
  const chosen = field(f, 'method')
  let method: Method = 'card'
  let brand = ''
  let last4 = ''
  let exp = ''
  let cardFp: string | undefined
  const savedId = field(f, 'saved')
  if (chosen === 'applepay' || chosen === 'googlepay') {
    // simulated wallet: no token reaches the server; it is charged as the test Visa 4242
    method = chosen
    ;[brand, last4, exp] = ['Visa', '4242', '12/39']
  } else if (chosen === 'paypal') {
    method = 'paypal'
    brand = 'PayPal'
  } else if (savedId) {
    const c = user && (db.prepare('SELECT brand, last4, exp, fp FROM saved_cards WHERE id = ? AND user_id = ?').get(Number(savedId), user.id) as { brand: string; last4: string; exp: string; fp: string | null } | undefined)
    if (!c) return bad('Saved card not found')
    // a saved card is not charged on the strength of the session alone: the CVC is typed again every time (express checkout included)
    if (!/^\d{3,4}$/.test(field(f, 'cvc'))) return bad('Enter the CVC of your saved card to confirm the payment')
    method = 'saved'
    ;({ brand, last4, exp } = c!)
    cardFp = c!.fp ?? undefined
  } else {
    // number and cvc live only in this function's locals; only brand + last4 + exp go further
    const card = { number: field(f, 'number').replace(/[\s-]/g, ''), exp: field(f, 'exp'), cvc: field(f, 'cvc') }
    const err = validateCard(card)
    if (err) return bad(err)
    ;({ exp } = card)
    brand = brandOf(card.number)
    last4 = card.number.slice(-4)
    cardFp = mac(`card:${card.number}`).toString('hex').slice(0, 32) // keyed hash for scalper detection; the number itself goes no further
  }

  let r
  try {
    r = finalize({ holdId, sessionToken: session.token, userId: user?.id ?? null, email, key, method, installments: f.get('installments') === 'on', brand, last4, exp, save: !!user && f.get('save') === 'on' && method === 'card', billing, src: (await cookies()).get('src')?.value, delivery: field(f, 'delivery') || 'mobile', ip, cardFp })
  } catch (e) {
    if (e instanceof HoldError) return e.status === 410 ? back(holdId, e.message) : bad(e.message)
    throw e
  }
  if ('orderId' in r) redirect(`/orders/${r.orderId}`)
  if ('threeDs' in r) redirect(`/checkout/3ds/${r.threeDs}`)
  if ('paypal' in r) redirect(`/checkout/paypal/${r.paypal}`)
  return bad(DECLINES[r.declined] ?? 'Payment declined')
}

// Promo code, per-ticket offers and add-ons. They are stored on the hold, so the next quote (and finalize, and 3DS) all see the same choices.
export async function applyOptions(f: FormData) {
  const session = await getSession()
  const holdId = Number(field(f, 'holdId'))
  if (!session || !Number.isInteger(holdId) || holdId < 1) redirect('/')
  const offers: Record<number, number> = {}
  const addons: Record<number, number> = {}
  for (const [k, v] of f.entries()) {
    const m = /^(offer|addon)-(\d+)$/.exec(k)
    if (m) (m[1] === 'offer' ? offers : addons)[Number(m[2])] = Number(v)
  }
  const promo = field(f, 'promo')
  if (promo && !allowed('promo', clientIp(await headers()), (await getUser())?.id ?? null, 10)) back(holdId, 'Too many attempts, wait a minute')
  try {
    setCheckoutOptions(holdId, session!.token, { promo: field(f, 'promo'), offers, addons, protection: f.get('protection') === 'on' })
  } catch (e) {
    if (e instanceof UserError) back(holdId, e.message)
    throw e
  }
  redirect(`/checkout/${holdId}?notice=${encodeURIComponent('Order updated')}`)
}

export async function threeDs(f: FormData) {
  await refuseImpersonation()
  const session = await getSession()
  const id = Number(field(f, 'paymentId'))
  if (!session || !Number.isInteger(id)) redirect('/')
  if (field(f, 'result') === 'fail') {
    const holdId = fail3ds(id, session!.token, field(f, 'provider') === 'paypal' ? 'paypal_cancelled' : '3ds_failed')
    if (!holdId) redirect('/')
    back(holdId!, DECLINES[field(f, 'provider') === 'paypal' ? 'paypal_cancelled' : '3ds_failed'])
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
