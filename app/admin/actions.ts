'use server'

import { redirect } from 'next/navigation'
import { db, tx } from '../../lib/db.ts'
import { refundEvent } from '../../lib/orders.ts'
import { audit, setFlag } from '../../lib/platform.ts'
import { requireAdmin } from '../../lib/session.ts'

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

// Re-run the (idempotent) event refund: only orders whose refund failed are touched.
export async function retryRefunds(f: FormData) {
  const admin = await requireAdmin()
  const id = num(f, 'eventId')
  if (!db.prepare("SELECT 1 FROM events WHERE id = ? AND status = 'cancelled'").get(id)) refuse('/admin/refunds', 'Only cancelled events can be retried')
  const r = refundEvent(id)
  audit(admin.id, 'refund.retry', `event:${id}`, r)
  done('/admin/refunds', `${r.refunded} refunded, ${r.failed} still failing`)
}
