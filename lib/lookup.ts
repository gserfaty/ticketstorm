import { randomInt, timingSafeEqual } from 'node:crypto'
import { db, tx } from './db.ts'
import { mac } from './defense.ts'
import { sendEmail } from './notify.ts'

// Guest order lookup: order number + email -> a 6-digit code emailed to the order's address -> access to that one order.
// The caller cannot tell whether an order exists (requestCode never reports it to the page), a code works once, for 15 minutes and 5 guesses.
export const LOOKUP_TTL_MS = 15 * 60_000
export const MAX_TRIES = 5
const hash = (orderId: number, code: string) => mac(`lookup:${orderId}:${code}`).toString('hex')

// Mails a fresh code when (order, email) match; older codes for the order die. Returns whether it mailed (for tests; pages must not show it).
export function requestCode(email: string, orderId: number, now = Date.now()): boolean {
  if (!Number.isSafeInteger(orderId) || orderId < 1) return false
  return tx(() => {
    const o = db.prepare("SELECT id, email FROM orders WHERE id = ? AND lower(email) = lower(?) AND status != 'pending'").get(orderId, email.trim()) as { id: number; email: string } | undefined
    if (!o) return false
    db.prepare('UPDATE lookup_codes SET used_at = ? WHERE order_id = ? AND used_at IS NULL').run(new Date(now).toISOString(), o.id)
    const code = String(randomInt(1_000_000)).padStart(6, '0')
    db.prepare('INSERT INTO lookup_codes (order_id, code_hash, expires_at) VALUES (?,?,?)').run(o.id, hash(o.id, code), new Date(now + LOOKUP_TTL_MS).toISOString())
    sendEmail(o.email, 'Your TicketStorm order lookup code', `Your code for order #${o.id} is ${code}. It works once and expires in 15 minutes. If you did not ask for it, ignore this email.`)
    return true
  })
}

export type Access = { orderId: number; token: string | null } // token = the guest order's access token; null = account order: log in instead

// Consumes the code on success. Wrong guesses count; the 5th wrong guess kills the code. Returns undefined for every failure alike.
export function redeemCode(email: string, orderId: number, code: string, now = Date.now()): Access | undefined {
  if (!/^\d{6}$/.test(code.trim()) || !Number.isSafeInteger(orderId)) return undefined
  return tx(() => {
    const o = db.prepare("SELECT id, user_id, access_token FROM orders WHERE id = ? AND lower(email) = lower(?)").get(orderId, email.trim()) as { id: number; user_id: number | null; access_token: string } | undefined
    if (!o) return undefined
    const c = db.prepare('SELECT id, code_hash FROM lookup_codes WHERE order_id = ? AND used_at IS NULL AND expires_at > ? AND attempts < ? ORDER BY id DESC LIMIT 1').get(o.id, new Date(now).toISOString(), MAX_TRIES) as { id: number; code_hash: string } | undefined
    if (!c) return undefined
    const want = Buffer.from(c.code_hash, 'hex')
    const got = Buffer.from(hash(o.id, code.trim()), 'hex')
    if (want.length !== got.length || !timingSafeEqual(want, got)) {
      db.prepare('UPDATE lookup_codes SET attempts = attempts + 1 WHERE id = ?').run(c.id)
      return undefined
    }
    if (db.prepare('UPDATE lookup_codes SET used_at = ? WHERE id = ? AND used_at IS NULL').run(new Date(now).toISOString(), c.id).changes !== 1) return undefined
    return { orderId: o.id, token: o.user_id === null ? o.access_token : null }
  })
}
