import { db } from './db.ts'
import { HoldError } from './inventory.ts'
import { ledgerAdd } from './ledger.ts'

// Stored value pays part of an order: account credit (credits table) and gift cards. Both are liabilities in the ledger:
//   issuing / returning value:  account +amount, cash -amount   (the platform still holds the money, it now owes it)
//   spending it on an order:    account -amount, cash +amount   (the order's settlement books the whole total as cash again)
// so every entry pair sums to zero. A refund of the part of an order that was paid with stored value goes back to the same credit / gift card.

export const creditBalance = (userId: number) => (db.prepare('SELECT coalesce(sum(amount), 0) AS b FROM credits WHERE user_id = ?').get(userId) as { b: number }).b
export const creditHistory = (userId: number) => db.prepare('SELECT amount, ref, created_at FROM credits WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(userId).map((r) => ({ ...r })) as { amount: number; ref: string; created_at: string }[]

export const addCredit = (userId: number, amount: number, ref: string) => void db.prepare('INSERT INTO credits (user_id, amount, ref) VALUES (?,?,?)').run(userId, amount, ref)

// Atomic: the row is inserted only while the balance covers it. False = not enough credit.
export const spendCredit = (userId: number, amount: number, ref: string): boolean =>
  db.prepare('INSERT INTO credits (user_id, amount, ref) SELECT ?, ?, ? WHERE (SELECT coalesce(sum(amount), 0) FROM credits WHERE user_id = ?) >= ?').run(userId, -amount, ref, userId, amount).changes === 1

// ---- gift cards (lib/giftcards.ts creates and looks them up) ----
export const giftAccount = (id: number) => `giftcard:${id}`

export type StoredPlan = { gift?: { id: number; amount: number }; credit: number; card: number }

// How a total is split: gift card first, then account credit, the rest on the card. Read-only; the balances are taken (guarded) when the order is created.
export function planStored(userId: number | null, total: number, gift: { id: number; balance: number } | undefined, useCredit: boolean): StoredPlan {
  let left = total
  const plan: StoredPlan = { credit: 0, card: total }
  if (gift) {
    plan.gift = { id: gift.id, amount: Math.min(gift.balance, left) }
    left -= plan.gift.amount
  }
  if (useCredit) {
    if (!userId) throw new HoldError('Log in to use account credit', 403)
    plan.credit = Math.min(creditBalance(userId), left)
    left -= plan.credit
  }
  plan.card = left
  return plan
}

// Inside createOrder's tx, once the order row exists: take the balances (a miss throws and rolls the whole order back) and record them as charges.
export function applyStored(orderId: number, userId: number | null, gift: { id: number; amount: number } | undefined, credit: number) {
  const pay = db.prepare("INSERT INTO payments (order_id, kind, method, amount, status, brand, meta, idempotency_key) VALUES (?, 'charge', ?, ?, 'succeeded', ?, ?, ?)")
  if (gift && gift.amount > 0) {
    if (db.prepare('UPDATE gift_cards SET balance_cents = balance_cents - ? WHERE id = ? AND balance_cents >= ?').run(gift.amount, gift.id, gift.amount).changes !== 1) throw new HoldError('The gift card balance changed: review your order', 409)
    pay.run(orderId, 'giftcard', gift.amount, 'Gift card', JSON.stringify({ gift_card_id: gift.id }), `gift-${orderId}`)
    ledgerAdd(giftAccount(gift.id), 'sale', -gift.amount, `order:${orderId}:gift`)
    ledgerAdd('cash', 'sale', gift.amount, `order:${orderId}:gift`)
  }
  if (credit > 0) {
    if (!userId || !spendCredit(userId, credit, `order:${orderId}`)) throw new HoldError('Your account credit changed: review your order', 409)
    pay.run(orderId, 'credit', credit, 'Account credit', null, `credit-${orderId}`)
    ledgerAdd(`credit:${userId}`, 'sale', -credit, `order:${orderId}:credit`)
    ledgerAdd('cash', 'sale', credit, `order:${orderId}:credit`)
  }
}

// The ledger account a refund payment returns value to: the buyer's credit, a gift card, or 'cash' (money back to a card / the bank).
export function refundAccount(method: string, parentMeta: string | null, userId: number | null): string {
  if (method === 'credit' && userId) return `credit:${userId}`
  if (method === 'giftcard' && parentMeta) return giftAccount((JSON.parse(parentMeta) as { gift_card_id: number }).gift_card_id)
  return 'cash'
}

// After refundMoney in the refund's tx: refunds that went to credit or a gift card put the value back (once per refund row: meta marks it done).
// Before the event is settled (or on a resale order) the ledger pair is written here; after settlement reverseAfterSettlement writes it
// (reports.ts) with the same account.
export function settleStoredRefunds(orderId: number) {
  const o = db.prepare('SELECT user_id, event_id, source FROM orders WHERE id = ?').get(orderId) as { user_id: number | null; event_id: number; source: string | null }
  const rows = db
    .prepare(`SELECT p.id, p.method, p.amount, (SELECT meta FROM payments WHERE id = p.parent_id) AS pmeta FROM payments p
      WHERE p.order_id = ? AND p.kind = 'refund' AND p.status = 'succeeded' AND p.method IN ('credit','giftcard') AND p.meta IS NULL`)
    .all(orderId) as { id: number; method: string; amount: number; pmeta: string | null }[]
  for (const p of rows) {
    const acct = refundAccount(p.method, p.pmeta, o.user_id)
    if (acct === 'cash') continue
    if (p.method === 'credit') addCredit(o.user_id!, p.amount, `refund:order:${orderId}`)
    else db.prepare('UPDATE gift_cards SET balance_cents = balance_cents + ? WHERE id = ?').run(p.amount, Number(acct.split(':')[1]))
    db.prepare("UPDATE payments SET meta = '{\"restored\":1}' WHERE id = ?").run(p.id)
    const after = db.prepare('SELECT last_refund_payment_id AS a FROM settlements WHERE event_id = ?').get(o.event_id) as { a: number } | undefined
    if (after && p.id > after.a && o.source !== 'resale') continue // reverseAfterSettlement books it
    ledgerAdd(acct, 'refund', p.amount, `stored:payment:${p.id}`)
    ledgerAdd('cash', 'refund', -p.amount, `stored:payment:${p.id}`)
  }
}
