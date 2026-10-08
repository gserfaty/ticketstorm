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

export type Payment = { id: number; status: string; order_id: number | null; decline_code: string | null; hold_id: number | null; session_token: string | null; amount: number; brand: string | null; last4: string | null; meta: string | null; idempotency_key: string }

// Idempotent: the UNIQUE idempotency_key is the guard. A repeated key returns the first row and charges nothing.
// Call inside tx().
export function recordCharge(p: { key: string; holdId: number; sessionToken: string; amount: number; method: 'card' | 'saved'; brand: string; last4: string; meta: object }): { payment: Payment; created: boolean } {
  const find = () => db.prepare('SELECT * FROM payments WHERE idempotency_key = ?').get(p.key) as Payment | undefined
  const prior = find()
  if (prior) return { payment: prior, created: false }
  const o = charge(p.last4)
  db.prepare(
    `INSERT INTO payments (hold_id, session_token, method, amount, status, brand, last4, decline_code, meta, idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(p.holdId, p.sessionToken, p.method, p.amount, o.status, p.brand, p.last4, o.code ?? null, JSON.stringify(p.meta), p.key)
  return { payment: find()!, created: true }
}

// Refund a succeeded charge. The 0341 test card charges fine but its refunds fail.
export function refund(paymentId: number, amount?: number) {
  const orig = db.prepare("SELECT * FROM payments WHERE id = ? AND kind = 'charge' AND status = 'succeeded'").get(paymentId) as (Payment & { method: string }) | undefined
  if (!orig) throw new Error('Nothing to refund')
  const failed = orig.last4 === '0341'
  db.prepare(
    `INSERT INTO payments (order_id, kind, method, amount, status, brand, last4, decline_code, idempotency_key) VALUES (?, 'refund', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(orig.order_id, orig.method, amount ?? orig.amount, failed ? 'declined' : 'succeeded', orig.brand, orig.last4, failed ? 'refund_failed' : null, `refund-${paymentId}-${randomBytes(6).toString('hex')}`)
  return !failed
}

export function listSavedCards(userId: number) {
  return db.prepare('SELECT id, brand, last4, exp FROM saved_cards WHERE user_id = ? ORDER BY id').all(userId).map((r) => ({ ...r })) as { id: number; brand: string; last4: string; exp: string }[]
}
