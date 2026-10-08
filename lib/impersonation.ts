import { randomBytes } from 'node:crypto'
import { db, tx } from './db.ts'
import { audit, UserError } from './platform.ts'

// Support impersonation (cookie handling is in lib/session.ts). An impersonation session is an ordinary session of the TARGET user that also
// carries impersonator_id, expires in an hour, and is refused by every guard that protects security settings, payment methods, payouts,
// organizer mutations and admin actions (session.ts requireSelf).
export const IMPERSONATION_MS = 3_600_000

export function startSession(adminId: number, targetId: number): string {
  return tx(() => {
    const a = db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'admin' AND status = 'active'").get(adminId)
    const t = db.prepare('SELECT role, status FROM users WHERE id = ?').get(targetId) as { role: string; status: string } | undefined
    if (!a) throw new UserError('Only admins can impersonate')
    if (!t || t.status !== 'active') throw new UserError('That user is not active')
    if (t.role === 'admin' || targetId === adminId) throw new UserError('Admins cannot be impersonated')
    const token = randomBytes(24).toString('base64url')
    db.prepare('INSERT INTO sessions (token, user_id, expires_at, impersonator_id) VALUES (?,?,?,?)').run(token, targetId, new Date(Date.now() + IMPERSONATION_MS).toISOString(), adminId)
    audit(adminId, 'impersonate.start', `user:${targetId}`)
    return token
  })
}

// Delete the session and audit the stop. Returns the admin to sign back in (if still an active admin).
export function endSession(token: string): number | undefined {
  return tx(() => {
    const s = db.prepare('SELECT user_id, impersonator_id FROM sessions WHERE token = ?').get(token) as { user_id: number; impersonator_id: number | null } | undefined
    if (!s?.impersonator_id) return undefined
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
    audit(s.impersonator_id, 'impersonate.stop', `user:${s.user_id}`)
    return (db.prepare("SELECT id FROM users WHERE id = ? AND role = 'admin' AND status = 'active'").get(s.impersonator_id) as { id: number } | undefined)?.id
  })
}

export const isImpersonating = (token: string | undefined | null) =>
  !!token && !!db.prepare('SELECT 1 FROM sessions WHERE token = ? AND impersonator_id IS NOT NULL').get(token)

export function assertNotImpersonating(token: string | undefined | null) {
  if (isImpersonating(token)) throw new UserError('Not available while viewing as another user')
}
