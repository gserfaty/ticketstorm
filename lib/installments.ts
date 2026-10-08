import { db, tx } from './db.ts'
import { holdOrder } from './fraud.ts'
import { APP_URL, notify, sendEmail } from './notify.ts'
import { offSession } from './payments.ts'
import { money } from './format.ts'

// "Pay in 4": the first quarter is charged at checkout, the other three are 'pending' payments rows with a due date and are charged by the
// job. Policy for a failed installment: the payment is declined, the order goes to 'review' (tickets stop working, the other installments
// pause) and the buyer is told. An admin then approves it (the unpaid part is written off) or cancels it (what was paid is refunded).
// ponytail: a failed installment is not retried automatically (one decline = review); add a retry schedule when real payments exist.
export const MIN_TOTAL = 4000 // cents
const DAY = 86_400_000

export type Part = { amount: number; dueAt: string | null } // dueAt null = charged now

// Four parts, the first takes the rounding. A part is due every 14 days, closer together when the show is near so the last one is due at
// least a day before it. null = not offered (too small, or the show is under 4 days away).
export function plan(total: number, startsAt: string, now = Date.now()): Part[] | null {
  const gap = Math.min(14 * DAY, Math.floor((Date.parse(startsAt) - now - DAY) / 3))
  if (total < MIN_TOTAL || gap < DAY) return null
  const q = Math.floor(total / 4)
  return [0, 1, 2, 3].map((i) => ({ amount: i === 0 ? total - 3 * q : q, dueAt: i === 0 ? null : new Date(now + i * gap).toISOString() }))
}

// Inside createOrder's tx: rows 2..4 of the plan, linked to the order. The first row is the checkout payment (same idempotency key + suffix).
export function addInstallments(orderId: number, first: { idempotency_key: string; brand: string | null; last4: string | null }, total: number, startsAt: string) {
  const parts = plan(total, startsAt)
  if (!parts) throw new Error('Pay in 4 is not available for this order')
  parts.slice(1).forEach((p, i) => {
    db.prepare("INSERT INTO payments (order_id, kind, method, amount, status, brand, last4, due_at, idempotency_key) VALUES (?, 'charge', 'installments', ?, 'pending', ?, ?, ?, ?)")
      .run(orderId, p.amount, first.brand, first.last4, p.dueAt, `${first.idempotency_key}-i${i + 2}`)
  })
}

// Charge every due installment once. Each is claimed with `WHERE status = 'pending'`, so running this twice (or two workers at once) charges once.
// Orders that are not 'paid' (in review, cancelled) are skipped; cancelling voids their pending rows.
export function chargeDueInstallments(now = Date.now()): number {
  const due = db
    .prepare(
      `SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE p.method = 'installments' AND p.kind = 'charge' AND p.status = 'pending' AND p.due_at <= ? AND o.status IN ('paid','partially_refunded') ORDER BY p.id`,
    )
    .all(new Date(now).toISOString()) as { id: number }[]
  let charged = 0
  for (const { id } of due) {
    tx(() => {
      // re-checked here: an earlier installment of the same order may just have failed and put it in review
      const p = db.prepare("SELECT p.order_id, p.amount, p.last4 FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.id = ? AND p.status = 'pending' AND o.status IN ('paid','partially_refunded')").get(id) as { order_id: number; amount: number; last4: string | null } | undefined
      if (!p) return
      const o = offSession(p.last4 ?? '')
      if (db.prepare('UPDATE payments SET status = ?, decline_code = ? WHERE id = ? AND status = ?').run(o.status, o.code ?? null, id, 'pending').changes !== 1) return
      const ord = db.prepare('SELECT user_id, email FROM orders WHERE id = ?').get(p.order_id) as { user_id: number | null; email: string }
      if (o.status === 'succeeded') {
        charged++
        if (ord.user_id) notify(ord.user_id, 'order', `Installment paid: ${money(p.amount)}`, `Order #${p.order_id}`, `/orders/${p.order_id}`)
        return
      }
      holdOrder(p.order_id, 'installment_failed')
      sendEmail(ord.email, `Payment problem on order #${p.order_id}`, `We could not charge your installment of ${money(p.amount)}. Your tickets are on hold until this is resolved.\n${APP_URL}/orders/${p.order_id}`)
    })
  }
  return charged
}
