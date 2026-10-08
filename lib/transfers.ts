import { randomBytes, timingSafeEqual } from 'node:crypto'
import { db, tx } from './db.ts'
import { HoldError } from './inventory.ts'
import { alertUser } from './alerts.ts'
import { APP_URL, notify, sendEmail, sendSms } from './notify.ts'
import { assertTradable } from './resale.ts'

const DAYS = 7
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const digits = (s: string) => s.replace(/\D/g, '')

export type Transfer = { id: number; ticket_id: number; from_user: number; to_email: string | null; to_phone: string | null; status: string; expires_at: string; claim_token: string }

// Offer a ticket to an email address or phone number. The ticket stays 'valid' (scannable) until the recipient accepts;
// the one-pending-per-ticket index and createListing's NOT EXISTS keep transfer and listing mutually exclusive.
export function createTransfer(userId: number, ticketId: number, to: string): number {
  to = to.trim()
  const email = /^\S+@\S+\.\S+$/.test(to) ? to.toLowerCase() : null
  const phone = !email && /^\+?[\d\s().-]+$/.test(to) && digits(to).length >= 7 && digits(to).length <= 15 ? to : null
  if (!email && !phone) throw new HoldError('Enter an email address or phone number', 400)
  return tx(() => {
    assertTradable(ticketId, userId)
    db.prepare("UPDATE transfers SET status = 'expired' WHERE ticket_id = ? AND status = 'pending' AND expires_at < ?").run(ticketId, new Date().toISOString())
    const me = db.prepare('SELECT email, phone, name FROM users WHERE id = ?').get(userId) as { email: string; phone: string | null; name: string }
    if (email === me.email.toLowerCase() || (phone && me.phone && digits(phone) === digits(me.phone))) throw new HoldError("You can't send a ticket to yourself", 400)
    const token = randomBytes(16).toString('hex') // 128 bits
    let id
    try {
      id = Number(
        db
          .prepare('INSERT INTO transfers (ticket_id, from_user, to_email, to_phone, expires_at, claim_token) VALUES (?,?,?,?,?,?)')
          .run(ticketId, userId, email, phone, new Date(Date.now() + DAYS * 86_400_000).toISOString(), token).lastInsertRowid,
      )
    } catch {
      throw new HoldError('This ticket already has a pending transfer')
    }
    const link = `${APP_URL}/transfers/${id}?token=${token}`
    const who = me.name || me.email
    if (email) {
      const text = `${who} sent you a ticket on TicketStorm. Log in or sign up to claim it (valid ${DAYS} days):\n${link}`
      const u = db.prepare("SELECT id FROM users WHERE email = ? AND status = 'active'").get(email) as { id: number } | undefined
      sendEmail(email, `${who} sent you a ticket`, text)
      if (u) alertUser(u.id, 'orders', 'transfer_received', `transfer:${id}`, { title: `${who} sent you a ticket`, link: `/transfers/${id}?token=${token}` }, { email: false })
    } else sendSms(phone!, `${who} sent you a TicketStorm ticket. Claim it: ${link}`)
    return id
  })
}

// Sender takes it back while still pending.
export function cancelTransfer(userId: number, transferId: number) {
  const r = db.prepare("UPDATE transfers SET status = 'cancelled' WHERE id = ? AND from_user = ? AND status = 'pending'").run(transferId, userId)
  if (r.changes !== 1) throw new HoldError('Transfer is no longer pending', 409)
}

// Sender (no token) or holder of the claim token. Returns undefined for anyone else.
export function viewTransfer(id: number, userId: number | null, token?: string | null): Transfer | undefined {
  const t = db.prepare('SELECT * FROM transfers WHERE id = ?').get(id) as Transfer | undefined
  if (!t) return undefined
  return t.from_user === userId || (token && same(token, t.claim_token)) ? t : undefined
}

function pendingFor(id: number, token: string): Transfer {
  const t = db.prepare('SELECT * FROM transfers WHERE id = ?').get(id) as Transfer | undefined
  if (!t || !same(token, t.claim_token)) throw new HoldError('Transfer not found', 404)
  if (t.status !== 'pending') throw new HoldError(`This transfer was ${t.status}`, 409)
  if (t.expires_at < new Date().toISOString()) throw new HoldError('This transfer has expired', 410)
  return t
}

// One tx: transfer accepted, old ticket 'transferred' (its secret dies with it: the scanner only admits 'valid'), new ticket + new secret for the recipient.
export function acceptTransfer(userId: number, transferId: number, token: string): number {
  return tx(() => {
    const t = pendingFor(transferId, token)
    if (t.from_user === userId) throw new HoldError("You can't accept your own transfer", 400)
    const old = db.prepare('SELECT order_id, inventory_id FROM tickets WHERE id = ?').get(t.ticket_id) as { order_id: number; inventory_id: number }
    assertTradable(t.ticket_id, t.from_user)
    if (db.prepare("UPDATE transfers SET status = 'accepted', to_user = ? WHERE id = ? AND status = 'pending'").run(userId, transferId).changes !== 1) throw new HoldError('Transfer is no longer pending', 409)
    if (db.prepare("UPDATE tickets SET status = 'transferred' WHERE id = ? AND status = 'valid' AND owner_id = ?").run(t.ticket_id, t.from_user).changes !== 1) throw new HoldError('Ticket is no longer transferable', 409)
    const id = Number(
      db.prepare('INSERT INTO tickets (order_id, inventory_id, owner_id, secret) VALUES (?,?,?,?)').run(old.order_id, old.inventory_id, userId, randomBytes(32).toString('hex')).lastInsertRowid,
    )
    notify(t.from_user, 'transfer', 'Your ticket transfer was accepted', '', '/tickets')
    alertUser(userId, 'orders', 'ticket_delivered', `transfer:${transferId}`, { title: 'A transferred ticket is in your account', link: '/tickets' }, { email: false })
    return id
  })
}

export function declineTransfer(transferId: number, token: string) {
  tx(() => {
    pendingFor(transferId, token)
    db.prepare("UPDATE transfers SET status = 'declined' WHERE id = ? AND status = 'pending'").run(transferId)
  })
}
