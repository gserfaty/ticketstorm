import { db, tx } from './db.ts'
import { sendEmail, notify } from './notify.ts'
import { money } from './format.ts'
import { refundInTx } from './orders.ts'
import { UserError } from './platform.ts'

// Opened inside createOrder for an order paid (in part) with the 0259 test card: the cardholder's bank disputes the charge.
export function openDispute(orderId: number, amount: number) {
  if (amount > 0) db.prepare("INSERT OR IGNORE INTO disputes (order_id, amount, reason) VALUES (?,?,'The bank reports the cardholder does not recognise this charge')").run(orderId, amount)
}

// Admin decides. won = the charge stands, nothing moves. lost = the bank takes the money back: the card part of the order is refunded as a
// 'chargeback' payment that cannot fail, the tickets are cancelled and the seats go back on sale, through the SAME refund function (so caps,
// stored-value returns and the zero-sum ledger reversals all apply). Stored value paid on the same order returns to its credit / gift card.
export function resolveDispute(adminId: number, disputeId: number, outcome: string, note: string) {
  if (outcome !== 'won' && outcome !== 'lost') throw new UserError('Choose won or lost')
  if (note.length > 500) throw new UserError('The note is limited to 500 characters')
  return tx(() => {
    const d = db.prepare('UPDATE disputes SET status = ?, note = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = ? RETURNING order_id, amount').get(outcome, note || null, adminId, new Date().toISOString(), disputeId, 'open') as { order_id: number; amount: number } | undefined
    if (!d) throw new UserError('Dispute not found or already decided')
    let refunded = 0
    if (outcome === 'lost') {
      const o = db.prepare('SELECT status, refund_error, email, user_id FROM orders WHERE id = ?').get(d.order_id) as { status: string; refund_error: string | null; email: string; user_id: number | null }
      // an order that is already refunded or cancelled without money owed has nothing left to claw back
      if (['paid', 'review', 'partially_refunded'].includes(o.status) || (o.status === 'cancelled' && o.refund_error)) {
        refunded = refundInTx(d.order_id, { reason: 'chargeback', via: 'chargeback', quiet: true }).amount
        sendEmail(o.email, `Order #${d.order_id} was reversed by your bank`, `Your bank reversed the ${money(refunded)} payment for order #${d.order_id} (chargeback). The order was cancelled and its tickets no longer work.`)
        if (o.user_id) notify(o.user_id, 'order', `Order #${d.order_id} was reversed by your bank`, 'The order was cancelled after a chargeback.', `/orders/${d.order_id}`)
      }
    }
    return { orderId: d.order_id, refunded }
  })
}
