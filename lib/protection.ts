import { db, tx } from './db.ts'
import { APP_URL, notify, sendEmail } from './notify.ts'
import { heldByBuyer, refundInTx } from './orders.ts'
import { UserError } from './platform.ts'
import { money } from './format.ts'

export const CLAIM_REASONS = ['illness', 'travel', 'schedule', 'weather', 'other']

// A claim on an order that bought protection (order_items kind 'protection'). One open-or-approved claim per order (partial unique index).
// Caller has already authorised the viewer for the order.
export function submitClaim(orderId: number, reason: string, details: string) {
  if (!CLAIM_REASONS.includes(reason)) throw new UserError('Pick a reason')
  if (details.length > 1000) throw new UserError('Details are limited to 1000 characters')
  tx(() => {
    const o = db.prepare("SELECT o.status, (SELECT count(*) FROM order_items WHERE order_id = o.id AND kind = 'protection') AS prot FROM orders o WHERE o.id = ?").get(orderId) as { status: string; prot: number } | undefined
    if (!o || !o.prot) throw new UserError('This order has no ticket protection')
    if (!['paid', 'partially_refunded'].includes(o.status)) throw new UserError(`An order that is ${o.status} cannot be claimed`)
    if (!heldByBuyer(orderId)) throw new UserError('Some of these tickets were transferred or sold, so the order cannot be claimed')
    try {
      db.prepare('INSERT INTO claims (order_id, reason, details) VALUES (?,?,?)').run(orderId, reason, details || null)
    } catch {
      throw new UserError('This order already has a claim')
    }
  })
}

// Approve = refund the order through the shared refund function WITHOUT the protection premium, cancel its tickets, one tx with the status change.
// The seats stay sold, as with an event cancellation (refundEvent): a claim is usually made close to or after the show, so there is nothing
// to resell, and the cancelled ticket cannot be scanned.
// If the card refuses the refund the whole thing rolls back and the claim stays 'submitted'.
export function decideClaim(claimId: number, adminId: number, approve: boolean) {
  tx(() => {
    const c = db.prepare("UPDATE claims SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'submitted' RETURNING order_id").get(approve ? 'approved' : 'denied', adminId, new Date().toISOString(), claimId) as { order_id: number } | undefined
    if (!c) throw new UserError('Claim not found or already decided')
    const o = db.prepare('SELECT user_id, email, access_token FROM orders WHERE id = ?').get(c.order_id) as { user_id: number | null; email: string; access_token: string }
    let text = `Your protection claim for order #${c.order_id} was denied.`
    if (approve) {
      const r = refundInTx(c.order_id, { reason: 'claim', keepProtection: true, release: false, quiet: true })
      text = `Your protection claim for order #${c.order_id} was approved. We refunded ${money(r.amount)}.`
    }
    sendEmail(o.email, `Claim on order #${c.order_id}`, `${text}\n${APP_URL}/orders/${c.order_id}${o.user_id ? '' : `?t=${o.access_token}`}`)
    if (o.user_id) notify(o.user_id, 'order', `Claim ${approve ? 'approved' : 'denied'}`, text, `/orders/${c.order_id}`)
  })
}
