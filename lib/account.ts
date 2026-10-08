import { db, tx } from './db.ts'
import { verifyPassword } from './auth.ts'
import { UserError } from './platform.ts'

const digits = (s: string) => s.replace(/\D/g, '')

export type Address = { line1: string; city: string; state: string; zip: string }
export const addressOf = (json: string | null): Address => ({ line1: '', city: '', state: '', zip: '', ...(json ? JSON.parse(json) : {}) })

export function updateProfile(userId: number, f: { name: string; phone: string; address: Address; password?: string }) {
  if (f.name.length > 80) throw new UserError('Name is limited to 80 characters')
  if (f.phone && (!/^\+?[\d\s().-]+$/.test(f.phone) || digits(f.phone).length < 7 || digits(f.phone).length > 15)) throw new UserError('Enter a valid phone number')
  for (const v of Object.values(f.address)) if (v.length > 100) throw new UserError('Address fields are limited to 100 characters')
  const cur = db.prepare('SELECT phone, twofa_enabled, password_hash FROM users WHERE id = ?').get(userId) as { phone: string | null; twofa_enabled: number; password_hash: string | null }
  // with 2FA on the phone receives the codes: it cannot be cleared, and changing it needs the password (a hijacked session must not redirect codes)
  if (cur.twofa_enabled && f.phone !== (cur.phone ?? '')) {
    if (!f.phone) throw new UserError('Turn off two-factor login before removing your phone number')
    if (!cur.password_hash || !verifyPassword(f.password ?? '', cur.password_hash)) throw new UserError('Enter your current password to change the phone number')
  }
  const any = Object.values(f.address).some(Boolean)
  db.prepare('UPDATE users SET name = ?, phone = ?, address = ? WHERE id = ?').run(f.name, f.phone || null, any ? JSON.stringify(f.address) : null, userId)
}

// Saved cards belong to one user; the id alone is never enough.
export function deleteCard(userId: number, cardId: number) {
  if (db.prepare('DELETE FROM saved_cards WHERE id = ? AND user_id = ?').run(cardId, userId).changes !== 1) throw new UserError('Card not found')
}

// Optional messages only. Order, ticket, transfer and event-change messages are essential: always sent, no preference, no unsubscribe.
export const PREF_CATEGORIES = ['alerts', 'marketing']
export const PREF_CHANNELS = ['inapp', 'email', 'sms']
export const PREF_LABELS: Record<string, string> = { alerts: 'Event alerts', marketing: 'News and offers' }
export type Prefs = Record<string, boolean>
// default: inbox on, alert mail on, marketing mail off, SMS off
export const prefsOf = (json: string | null): Prefs => ({
  alerts_inapp: true, marketing_inapp: true, alerts_email: true, ...(json ? JSON.parse(json) : {}),
})
export function savePrefs(userId: number, checked: string[]) {
  const prefs: Prefs = {}
  for (const c of PREF_CATEGORIES) for (const ch of PREF_CHANNELS) prefs[`${c}_${ch}`] = checked.includes(`${c}_${ch}`)
  db.prepare('UPDATE users SET notif_prefs = ? WHERE id = ?').run(JSON.stringify(prefs), userId)
}

// Where alerts about followed artists and venues are sent: events within `radius` miles of the home city.
export function saveAlertArea(userId: number, cityId: string, radius: string) {
  const mi = Number(radius)
  if (!Number.isInteger(mi) || mi < 1 || mi > 3000) throw new UserError('Radius must be a whole number of miles from 1 to 3000')
  if (cityId !== '' && !db.prepare('SELECT 1 FROM cities WHERE id = ?').get(Number(cityId))) throw new UserError('Unknown city')
  db.prepare('UPDATE users SET home_city_id = ?, alert_radius_mi = ? WHERE id = ?').run(cityId === '' ? null : Number(cityId), mi, userId)
}

// Everything we hold about ONE user (GDPR export). Selected by the logged-in user's id only. Ticket secrets, password hashes, gateway tokens and
// other people's data are left out.
type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
export function exportData(userId: number): Row {
  const all = (sql: string, ...a: (string | number)[]): Row[] => db.prepare(sql).all(...a).map((r) => ({ ...r }))
  const user = db.prepare('SELECT id, email, name, phone, role, email_verified_at, twofa_enabled, address, notif_prefs, home_city_id, created_at FROM users WHERE id = ?').get(userId) as Row
  const orders = all('SELECT id, event_id, email, status, subtotal, fees, tax, protection, discount, total, source, created_at FROM orders WHERE user_id = ? ORDER BY id', userId).map((o) => ({
    ...o,
    items: all('SELECT id, kind, inventory_id, addon_id, unit_cents, fee_cents, tax_cents, refunded_cents FROM order_items WHERE order_id = ?', o.id),
    payments: all('SELECT id, kind, method, amount, status, brand, last4, created_at FROM payments WHERE order_id = ? ORDER BY id', o.id),
    claims: all('SELECT id, reason, details, status, created_at FROM claims WHERE order_id = ?', o.id),
  }))
  return {
    exported_at: new Date().toISOString(),
    user: { ...user, address: user.address ? JSON.parse(user.address) : null, notif_prefs: user.notif_prefs ? JSON.parse(user.notif_prefs) : null },
    orders,
    tickets: all('SELECT id, order_id, inventory_id, addon_id, status, scanned_at, created_at FROM tickets WHERE owner_id = ? ORDER BY id', userId),
    saved_cards: all('SELECT brand, last4, exp, created_at FROM saved_cards WHERE user_id = ?', userId),
    transfers: all('SELECT id, ticket_id, from_user, to_email, to_phone, status, created_at FROM transfers WHERE from_user = ? OR to_user = ?', userId, userId),
    listings: all('SELECT id, ticket_id, price_cents, status, created_at FROM listings WHERE seller_id = ?', userId),
    favorites: all('SELECT kind, ref_id, created_at FROM favorites WHERE user_id = ?', userId),
    notifications: all('SELECT kind, title, body, link, read_at, created_at FROM notifications WHERE user_id = ?', userId),
    linked_logins: all('SELECT provider, created_at FROM oauth_links WHERE user_id = ?', userId),
    ledger: all('SELECT kind, amount, ref, created_at FROM ledger WHERE account = ?', `user:${userId}`),
  }
}

// Delete = anonymize. The row stays so orders, tickets and ledger entries keep their foreign keys; every personal field goes, sessions die,
// and open listings / transfers are cancelled. `confirm` is the password (or the email for accounts that only use social login).
export function deleteAccount(userId: number, confirm: string) {
  tx(() => {
    const u = db.prepare('SELECT email, password_hash, role, status FROM users WHERE id = ?').get(userId) as { email: string; password_hash: string | null; role: string; status: string }
    if (u.status === 'deleted') throw new UserError('Account already deleted')
    if (u.password_hash ? !verifyPassword(confirm, u.password_hash) : confirm.trim().toLowerCase() !== u.email) throw new UserError(u.password_hash ? 'Wrong password' : 'Type your email address to confirm')
    if (u.role === 'admin') throw new UserError('Admins cannot delete their own account')
    if (db.prepare('SELECT 1 FROM org_members WHERE user_id = ?').get(userId)) throw new UserError('Leave your organizations first')
    if (db.prepare("SELECT 1 FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.user_id = ? AND p.status = 'pending'").get(userId)) throw new UserError('Finish paying your pay-in-4 orders first')
    for (const l of db.prepare("UPDATE listings SET status = 'cancelled', hold_id = NULL, held_until = NULL WHERE seller_id = ? AND status = 'active' RETURNING ticket_id").all(userId) as { ticket_id: number }[]) {
      db.prepare("UPDATE tickets SET status = 'valid' WHERE id = ? AND status = 'listed'").run(l.ticket_id)
    }
    db.prepare("UPDATE transfers SET status = 'cancelled' WHERE from_user = ? AND status = 'pending'").run(userId)
    const gone = `deleted-${userId}@deleted.invalid`
    db.prepare("UPDATE users SET email = ?, name = '', phone = NULL, address = NULL, notif_prefs = NULL, password_hash = NULL, twofa_enabled = 0, home_city_id = NULL, status = 'deleted' WHERE id = ?").run(gone, userId)
    db.prepare('UPDATE orders SET email = ? WHERE user_id = ?').run(gone, userId)
    db.prepare('UPDATE payments SET meta = NULL WHERE order_id IN (SELECT id FROM orders WHERE user_id = ?)').run(userId)
    for (const t of ['sessions', 'saved_cards', 'oauth_links', 'favorites', 'notifications', 'codes']) db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId)
  })
}
