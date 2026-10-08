'use server'

import { redirect } from 'next/navigation'
import { db, tx } from '../../lib/db.ts'
import { approveReview, holdOrder } from '../../lib/fraud.ts'
import { refundFromForm } from '../../lib/orderadmin.ts'
import { refundEvent, refundOrder, sendConfirmation } from '../../lib/orders.ts'
import { resolveDispute } from '../../lib/disputes.ts'
import { decideClaim } from '../../lib/protection.ts'
import { audit, setFlag, UserError } from '../../lib/platform.ts'
import { setCityTax, setFeeDefaults } from '../../lib/pricing.ts'
import { setResaleDefaults } from '../../lib/rules.ts'
import { decidePayout } from '../../lib/payouts.ts'
import { cancelCluster } from '../../lib/scalpers.ts'
import { addMessage, closeTicket } from '../../lib/support.ts'
import { requireAdmin, startImpersonation } from '../../lib/session.ts'

const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim()
const num = (f: FormData, k: string) => Number(f.get(k))

const done = (back: string, msg: string): never => redirect(`${back}?notice=${encodeURIComponent(msg)}`)
const refuse = (back: string, msg: string): never => redirect(`${back}?error=${encodeURIComponent(msg)}`)

export async function setUserStatus(f: FormData) {
  const admin = await requireAdmin()
  const id = num(f, 'userId')
  const status = text(f, 'status') === 'blocked' ? 'blocked' : 'active'
  if (id === admin.id) refuse('/admin/users', 'You cannot block yourself')
  tx(() => {
    db.prepare("UPDATE users SET status = ? WHERE id = ? AND status != 'deleted'").run(status, id)
    if (status === 'blocked') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id)
    audit(admin.id, `user.${status === 'blocked' ? 'block' : 'unblock'}`, `user:${id}`)
  })
  done('/admin/users', 'Updated')
}

export async function setUserRole(f: FormData) {
  const admin = await requireAdmin()
  const id = num(f, 'userId')
  const role = text(f, 'role') === 'admin' ? 'admin' : 'fan'
  if (id === admin.id) refuse('/admin/users', 'You cannot change your own role')
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id)
  audit(admin.id, 'user.role', `user:${id}`, { role })
  done('/admin/users', 'Updated')
}

export async function setOrgStatus(f: FormData) {
  const admin = await requireAdmin()
  const id = num(f, 'orgId')
  const status = ['approved', 'suspended', 'pending'].includes(text(f, 'status')) ? text(f, 'status') : 'pending'
  db.prepare('UPDATE orgs SET status = ? WHERE id = ?').run(status, id)
  audit(admin.id, 'org.status', `org:${id}`, { status })
  done('/admin/orgs', 'Updated')
}

// approve = visible to fans; unpublish = hidden again (tickets and orders are untouched)
export async function setEventApproval(f: FormData) {
  const admin = await requireAdmin()
  const id = num(f, 'eventId')
  const approved = f.get('approved') === '1' ? 1 : 0
  db.prepare('UPDATE events SET approved = ? WHERE id = ?').run(approved, id)
  audit(admin.id, approved ? 'event.approve' : 'event.unpublish', `event:${id}`)
  done('/admin/events', 'Updated')
}

export async function editEventText(f: FormData) {
  const admin = await requireAdmin()
  const id = num(f, 'eventId')
  if (!text(f, 'title')) refuse('/admin/events', 'Title required')
  db.prepare('UPDATE events SET title = ?, description = ? WHERE id = ?').run(text(f, 'title'), text(f, 'description') || null, id)
  audit(admin.id, 'event.edit_text', `event:${id}`)
  done('/admin/events', 'Updated')
}

export async function toggleFlag(f: FormData) {
  const admin = await requireAdmin()
  const key = text(f, 'key')
  if (!db.prepare('SELECT 1 FROM feature_flags WHERE key = ?').get(key)) refuse('/admin/flags', 'Unknown flag')
  setFlag(key, f.get('enabled') === '1')
  audit(admin.id, 'flag.set', `flag:${key}`, { enabled: f.get('enabled') === '1' })
  done('/admin/flags', 'Updated')
}

// Platform fee defaults; an event's own fee_rule still overrides them field by field.
export async function saveFeeDefaults(f: FormData) {
  const admin = await requireAdmin()
  try {
    const rule = setFeeDefaults({ service_pct: f.get('service_pct'), facility_cents: f.get('facility_cents'), order_cents: f.get('order_cents'), delivery_cents: f.get('delivery_cents') })
    audit(admin.id, 'fees.defaults', 'settings:fee_defaults', rule)
  } catch (e) {
    if (e instanceof UserError) refuse('/admin/fees', e.message)
    throw e
  }
  done('/admin/fees', 'Fee defaults saved')
}

export async function saveResaleDefaultsAction(f: FormData) {
  const admin = await requireAdmin()
  try {
    const r = setResaleDefaults({ enabled: f.get('enabled'), min_pct: f.get('min_pct'), max_pct: f.get('max_pct'), seller_fee_pct: f.get('seller_fee_pct'), buyer_fee_pct: f.get('buyer_fee_pct') })
    audit(admin.id, 'resale.defaults', 'settings:resale_defaults', r)
  } catch (e) {
    if (e instanceof UserError) refuse('/admin/fees', e.message)
    throw e
  }
  done('/admin/fees', 'Resale defaults saved')
}

export async function saveCityTax(f: FormData) {
  const admin = await requireAdmin()
  const id = num(f, 'cityId')
  try {
    audit(admin.id, 'tax.set', `city:${id}`, { bps: setCityTax(id, f.get('bps')) })
  } catch (e) {
    if (e instanceof UserError) refuse('/admin/taxes', e.message)
    throw e
  }
  done('/admin/taxes', 'Tax rate saved')
}

// Re-run the (idempotent) event refund: only orders whose refund failed are touched.
export async function retryRefunds(f: FormData) {
  const admin = await requireAdmin()
  const id = num(f, 'eventId')
  if (!db.prepare("SELECT 1 FROM events WHERE id = ? AND status = 'cancelled'").get(id)) refuse('/admin/refunds', 'Only cancelled events can be retried')
  const r = refundEvent(id)
  audit(admin.id, 'refund.retry', `event:${id}`, r)
  done('/admin/refunds', `${r.refunded} refunded, ${r.failed} still failing`)
}

// ---- P9: review queue, claims, order tools ----
// Run a mutation and bounce back with a notice, or with the message of a UserError.
function run(back: string, fn: () => void, ok: string): never {
  try {
    fn()
  } catch (e) {
    if (e instanceof UserError) return refuse(back, e.message)
    throw e
  }
  return done(back, ok)
}

export async function reviewApprove(f: FormData) {
  const admin = await requireAdmin()
  const id = num(f, 'orderId')
  run('/admin/review', () => {
    if (!approveReview(id)) throw new UserError('That order is not in review')
    audit(admin.id, 'order.approve', `order:${id}`)
  }, 'Approved: the tickets work now')
}

// Cancel = refund what was paid through the shared refund function and put the seats back on sale.
export async function reviewCancel(f: FormData) {
  const admin = await requireAdmin()
  const id = num(f, 'orderId')
  run('/admin/review', () => {
    if (!db.prepare("SELECT 1 FROM orders WHERE id = ? AND status = 'review'").get(id)) throw new UserError('That order is not in review')
    const r = refundOrder(id, { reason: 'review_cancelled' })
    audit(admin.id, 'order.review_cancel', `order:${id}`, r)
  }, 'Cancelled and refunded')
}

export async function claimDecision(f: FormData) {
  const admin = await requireAdmin()
  const id = num(f, 'claimId')
  const approve = text(f, 'decision') === 'approve'
  run('/admin/claims', () => {
    decideClaim(id, admin.id, approve)
    audit(admin.id, approve ? 'claim.approve' : 'claim.deny', `claim:${id}`)
  }, approve ? 'Approved and refunded' : 'Denied')
}

export async function adminOrderRefund(f: FormData) {
  const admin = await requireAdmin()
  const id = num(f, 'orderId')
  const mode = text(f, 'mode')
  run('/admin/orders', () => {
    const r = refundFromForm(id, mode, f.getAll('item').map(Number), f.get('fees') === 'on', `admin:${admin.id}`, f.get('credit') === 'on')
    audit(admin.id, `order.${mode === 'void' ? 'void' : 'refund'}`, `order:${id}`, { mode, items: f.getAll('item'), amount: r.amount })
  }, 'Done')
}

export async function adminOrderResend(f: FormData) {
  const admin = await requireAdmin()
  const id = num(f, 'orderId')
  run('/admin/orders', () => { sendConfirmation(id); audit(admin.id, 'order.resend', `order:${id}`) }, 'Tickets re-sent')
}

export async function adminOrderHold(f: FormData) {
  const admin = await requireAdmin()
  const id = num(f, 'orderId')
  run('/admin/orders', () => {
    if (!tx(() => holdOrder(id, 'admin_hold'))) throw new UserError('Only a paid order can be held')
    audit(admin.id, 'order.hold', `order:${id}`)
  }, 'Order held')
}

export async function adminOrderRelease(f: FormData) {
  const admin = await requireAdmin()
  const id = num(f, 'orderId')
  run('/admin/orders', () => {
    if (!approveReview(id)) throw new UserError('That order is not in review')
    audit(admin.id, 'order.release', `order:${id}`)
  }, 'Released')
}

// Payouts (users and orgs): mark paid or reject (funds return to the account).
export async function payoutDecision(f: FormData) {
  const admin = await requireAdmin()
  const id = num(f, 'payoutId')
  const paid = text(f, 'decision') === 'paid'
  run('/admin/payouts', () => {
    decidePayout(id, admin.id, paid)
    audit(admin.id, paid ? 'payout.paid' : 'payout.reject', `payout:${id}`)
  }, paid ? 'Marked paid' : 'Rejected: the funds are back in the balance')
}

// ---- fraud and bots ----
export async function blocklistAdd(f: FormData) {
  const admin = await requireAdmin()
  const kind = text(f, 'kind') === 'email' ? 'email' : 'ip'
  const value = text(f, 'value').toLowerCase()
  run('/admin/fraud', () => {
    if (!value || value.length > 200 || (kind === 'email' && !/^\S+@\S+$/.test(value))) throw new UserError('Enter an IP address or an email')
    if (db.prepare('INSERT OR IGNORE INTO blocklist (kind, value) VALUES (?,?)').run(kind, value).changes !== 1) throw new UserError('Already on the blocklist')
    audit(admin.id, 'blocklist.add', `${kind}:${value}`)
  }, 'Added to the blocklist')
}

export async function blocklistRemove(f: FormData) {
  const admin = await requireAdmin()
  const id = num(f, 'id')
  run('/admin/fraud', () => {
    const b = db.prepare('DELETE FROM blocklist WHERE id = ? RETURNING kind, value').get(id) as { kind: string; value: string } | undefined
    if (!b) throw new UserError('Entry not found')
    audit(admin.id, 'blocklist.remove', `${b.kind}:${b.value}`)
  }, 'Removed')
}

export async function setUserFlag(f: FormData) {
  const admin = await requireAdmin()
  const id = num(f, 'userId')
  const flagged = f.get('flagged') === '1' ? 1 : 0
  db.prepare('UPDATE users SET flagged = ? WHERE id = ?').run(flagged, id)
  audit(admin.id, flagged ? 'user.flag' : 'user.unflag', `user:${id}`)
  done(text(f, 'back') === 'fraud' ? '/admin/fraud' : '/admin/users', 'Updated')
}

// ---- support ----
export async function supportReply(f: FormData) {
  const admin = await requireAdmin()
  const id = num(f, 'ticketId')
  run(`/admin/support/${id}`, () => {
    addMessage(id, { staff: true, name: admin.name || 'Support' }, String(f.get('message') ?? ''))
    audit(admin.id, 'support.reply', `support:${id}`)
  }, 'Reply sent')
}

export async function supportClose(f: FormData) {
  const admin = await requireAdmin()
  const id = num(f, 'ticketId')
  run(`/admin/support/${id}`, () => { closeTicket(id); audit(admin.id, 'support.close', `support:${id}`) }, 'Closed')
}

// ---- impersonation ----
// Start/stop are audited inside lib/impersonation.ts. The action swaps this admin's session for a 1-hour session of the target.
export async function impersonateUser(f: FormData) {
  const admin = await requireAdmin()
  try {
    await startImpersonation(admin.id, num(f, 'userId'))
  } catch (e) {
    if (e instanceof UserError) refuse('/admin/users', e.message)
    throw e
  }
  redirect('/')
}

// Bulk-cancel one scalper cluster. Only (event, kind, key) come from the form; the orders are looked up server-side and refunded one by one.
export async function cancelScalperOrders(f: FormData) {
  const admin = await requireAdmin()
  const r = cancelCluster(num(f, 'eventId'), text(f, 'kind'), text(f, 'key'))
  audit(admin.id, 'scalper.cancel_orders', `event:${num(f, 'eventId')}`, { kind: text(f, 'kind'), key: text(f, 'key').slice(0, 12), cancelled: r.cancelled, failed: r.failed })
  if (r.failed.length) refuse('/admin/scalpers', `Cancelled ${r.cancelled.length}; ${r.failed.length} failed: ${r.failed.map((x) => `#${x.id} ${x.why}`).join('; ')}`)
  done('/admin/scalpers', `Cancelled and refunded ${r.cancelled.length} order(s)`)
}

export async function disputeDecision(f: FormData) {
  const admin = await requireAdmin()
  run('/admin/disputes', () => {
    const r = resolveDispute(admin.id, num(f, 'disputeId'), text(f, 'outcome'), text(f, 'note'))
    audit(admin.id, `dispute.${text(f, 'outcome')}`, `order:${r.orderId}`, { disputeId: num(f, 'disputeId'), refunded: r.refunded, note: text(f, 'note') })
  }, 'Dispute resolved')
}
