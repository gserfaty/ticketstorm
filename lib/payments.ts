import { randomBytes } from 'node:crypto'
import { db } from './db.ts'

// Fake gateway. Card numbers and CVCs exist only inside the request that carries them: never stored, never logged.
// Only brand + last4 are kept. Behaviour is keyed on last4 (the published test cards).
export type Card = { number: string; exp: string; cvc: string }
export type Outcome = { status: 'succeeded' | 'declined' | 'requires_3ds'; code?: string }

function luhn(n: string): boolean {
  let sum = 0
  for (let i = 0; i < n.length; i++) {
    let d = Number(n[n.length - 1 - i])
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2
    sum += d
  }
  return sum % 10 === 0
}

export function brandOf(number: string): string {
  return number.startsWith('4') ? 'Visa' : /^(5[1-5]|2[2-7])/.test(number) ? 'Mastercard' : /^3[47]/.test(number) ? 'Amex' : 'Card'
}

// Returns an error message, or null if the card looks valid. `now` is injectable for tests.
export function validateCard(c: Card, now = new Date()): string | null {
  if (!/^\d{13,19}$/.test(c.number) || !luhn(c.number)) return 'Card number is invalid'
  const m = /^(\d{2})\/(\d{2})$/.exec(c.exp)
  if (!m || +m[1] < 1 || +m[1] > 12) return 'Expiry must be MM/YY'
  if (2000 + +m[2] < now.getUTCFullYear() || (2000 + +m[2] === now.getUTCFullYear() && +m[1] < now.getUTCMonth() + 1)) return 'Card has expired'
  if (!/^\d{3,4}$/.test(c.cvc)) return 'CVC must be 3 or 4 digits'
  return null
}

const BEHAVIOUR: Record<string, Outcome> = {
  '0002': { status: 'declined', code: 'card_declined' },
  '9995': { status: 'declined', code: 'insufficient_funds' },
  '3220': { status: 'requires_3ds' },
}
export const charge = (last4: string): Outcome => BEHAVIOUR[last4] ?? { status: 'succeeded' }

export type Method = 'card' | 'saved' | 'applepay' | 'googlepay' | 'paypal' | 'installments'
export type Payment = { id: number; status: string; order_id: number | null; decline_code: string | null; hold_id: number | null; session_token: string | null; amount: number; brand: string | null; last4: string | null; meta: string | null; idempotency_key: string }

// Idempotent: the UNIQUE idempotency_key is the guard. A repeated key returns the first row and charges nothing.
// Call inside tx().
export function recordCharge(p: { key: string; holdId: number; sessionToken: string; amount: number; method: Method; brand: string; last4: string; meta: object }): { payment: Payment; created: boolean } {
  const find = () => db.prepare('SELECT * FROM payments WHERE idempotency_key = ?').get(p.key) as Payment | undefined
  const prior = find()
  if (prior) return { payment: prior, created: false }
  // PayPal has no card: the payment waits for the shopper to approve it on the (mock) PayPal page
  const o: { status: string; code?: string } = p.method === 'paypal' ? { status: 'pending' } : charge(p.last4)
  db.prepare(
    `INSERT INTO payments (hold_id, session_token, method, amount, status, brand, last4, decline_code, meta, idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(p.holdId, p.sessionToken, p.method, p.amount, o.status, p.brand, p.last4 || null, o.code ?? null, JSON.stringify(p.meta), p.key)
  return { payment: find()!, created: true }
}

// ---- refunds: the only code that writes refund rows ----
const sum = (where: string, ...a: (string | number)[]) =>
  (db.prepare(`SELECT coalesce(sum(amount), 0) AS s FROM payments WHERE ${where}`).get(...a) as { s: number }).s
export const paidOf = (orderId: number) => sum("order_id = ? AND kind = 'charge' AND status = 'succeeded'", orderId)
export const refundedOf = (orderId: number) => sum("order_id = ? AND kind = 'refund' AND status = 'succeeded'", orderId)
const refundedFrom = (chargeId: number) => sum("parent_id = ? AND kind = 'refund' AND status = 'succeeded'", chargeId)

// Return `amount` of one succeeded charge (default: all that is left of it). Never more than the charge minus what it already gave back.
// The 0341 test card charges fine but its refunds fail (returns false, a declined refund row is kept). `via` 'exchange' moves credit inside
// TicketStorm and cannot fail.
export function refund(paymentId: number, amount?: number, via?: string) {
  const orig = db.prepare("SELECT * FROM payments WHERE id = ? AND kind = 'charge' AND status = 'succeeded'").get(paymentId) as (Payment & { method: string }) | undefined
  if (!orig) throw new Error('Nothing to refund')
  const left = orig.amount - refundedFrom(paymentId)
  const amt = amount ?? left
  if (!Number.isInteger(amt) || amt < 1 || amt > left) throw new Error('Refund exceeds what was paid')
  const method = via ?? orig.method
  const failed = orig.last4 === '0341' && method !== 'exchange'
  db.prepare(
    `INSERT INTO payments (order_id, kind, method, amount, status, brand, last4, decline_code, parent_id, idempotency_key) VALUES (?, 'refund', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(orig.order_id, method, amt, failed ? 'declined' : 'succeeded', orig.brand, orig.last4, failed ? 'refund_failed' : null, paymentId, `refund-${paymentId}-${randomBytes(6).toString('hex')}`)
  return !failed
}

// Give `amount` back on an order, spread over its charges oldest first. Throws if that is more than paid minus already refunded.
// `toOrder` (exchange): the credit is not paid out, it becomes a charge on that order. Returns false if the card refused (0341).
export function refundMoney(orderId: number, amount: number, via?: string, toOrder?: number): boolean {
  if (amount < 0 || amount > paidOf(orderId) - refundedOf(orderId)) throw new Error('Refund exceeds what was paid')
  let left = amount
  for (const c of db.prepare("SELECT id, amount, brand, last4 FROM payments WHERE order_id = ? AND kind = 'charge' AND status = 'succeeded' ORDER BY id").all(orderId) as { id: number; amount: number; brand: string; last4: string }[]) {
    const take = Math.min(left, c.amount - refundedFrom(c.id))
    if (take < 1) continue
    if (!refund(c.id, take, via)) return false
    if (toOrder) {
      db.prepare("INSERT INTO payments (order_id, kind, method, amount, status, brand, last4, idempotency_key) VALUES (?, 'charge', 'exchange', ?, 'succeeded', ?, ?, ?)")
        .run(toOrder, take, c.brand, c.last4, `credit-${toOrder}-${c.id}-${randomBytes(4).toString('hex')}`)
    }
    left -= take
  }
  return true
}

// a payment nobody is there to authenticate: 3DS cards cannot be charged
export const offSession = (last4: string): Outcome => {
  const o = charge(last4)
  return o.status === 'requires_3ds' ? { status: 'declined', code: 'authentication_required' } : o
}

// Charge the card `cardOrder` was paid with again, as a payment on `toOrder` (exchange upcharge). Idempotent on `key`.
export function chargeStored(cardOrder: number, toOrder: number, amount: number, key: string): Payment {
  const find = () => db.prepare('SELECT * FROM payments WHERE idempotency_key = ?').get(key) as Payment | undefined
  const prior = find()
  if (prior) return prior
  const c = db.prepare("SELECT brand, last4 FROM payments WHERE order_id = ? AND kind = 'charge' AND status = 'succeeded' ORDER BY id").get(cardOrder) as { brand: string; last4: string } | undefined // exchange credits carry the card of the payment they came from
  if (!c) throw new Error('No card on this order')
  const o = offSession(c.last4)
  db.prepare("INSERT INTO payments (order_id, kind, method, amount, status, brand, last4, decline_code, idempotency_key) VALUES (?, 'charge', 'card', ?, ?, ?, ?, ?, ?)")
    .run(toOrder, amount, o.status, c.brand, c.last4, o.code ?? null, key)
  return find()!
}

export function listSavedCards(userId: number) {
  return db.prepare('SELECT id, brand, last4, exp FROM saved_cards WHERE user_id = ? ORDER BY id').all(userId).map((r) => ({ ...r })) as { id: number; brand: string; last4: string; exp: string }[]
}
