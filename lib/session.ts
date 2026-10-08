import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { db, tx } from './db.ts'
import { randomToken } from './auth.ts'
import type { Viewer } from './orders.ts'
import { assertNotImpersonating, endSession, startSession } from './impersonation.ts'
import { UserError } from './platform.ts'

export const COOKIE = 'ticketstorm_session'
const DAYS = 30

export type User = {
  id: number
  email: string
  name: string
  role: 'fan' | 'admin'
  email_verified_at: string | null
  status: string
}

async function setCookie(token: string) {
  const expires = new Date(Date.now() + DAYS * 86_400_000)
  ;(await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    expires,
  })
}

function createSession(userId: number | null): string {
  const token = randomToken()
  const expires = new Date(Date.now() + DAYS * 86_400_000).toISOString()
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run(token, userId, expires)
  return token
}

// Valid, unexpired session row for the current cookie (or undefined). Read-only.
export async function getSession() {
  const token = (await cookies()).get(COOKIE)?.value
  if (!token) return undefined
  return db.prepare('SELECT token, user_id, impersonator_id FROM sessions WHERE token = ? AND expires_at > ?').get(token, new Date().toISOString()) as
    | { token: string; user_id: number | null; impersonator_id: number | null }
    | undefined
}

// Lazy anonymous guest session. Only call from server actions / route handlers (they may set cookies).
export async function ensureSession(): Promise<string> {
  const s = await getSession()
  if (s) return s.token
  const token = createSession(null)
  await setCookie(token)
  return token
}

export async function getUser(): Promise<User | undefined> {
  const s = await getSession()
  if (!s?.user_id) return undefined
  return db
    .prepare("SELECT id, email, name, role, email_verified_at, status FROM users WHERE id = ? AND status = 'active'")
    .get(s.user_id) as User | undefined
}

// Who is looking, for order/ticket authorization. `token` is the emailed-link credential, if any.
export async function getViewer(token?: string | null): Promise<Viewer> {
  const s = await getSession()
  return { userId: (await getUser())?.id ?? null, sessionToken: s?.token ?? null, token }
}

export async function requireUser(): Promise<User> {
  const u = await getUser()
  if (!u) redirect('/login')
  return u
}

// Logged in as yourself. While an admin impersonates a user, security, payment and payout changes are refused (they redirect with a message).
export async function refuseImpersonation() {
  try {
    assertNotImpersonating((await getSession())?.token)
  } catch (e) {
    if (e instanceof UserError) redirect(`/?error=${encodeURIComponent(e.message)}`)
    throw e
  }
}

export async function requireSelf(): Promise<User> {
  const u = await requireUser()
  await refuseImpersonation()
  return u
}

export async function requireAdmin(): Promise<User> {
  const u = await requireSelf() // an impersonating admin is the target user, not an admin: admin actions are refused
  if (u.role !== 'admin') redirect('/')
  return u
}

export function memberRole(userId: number, orgId: number): string | undefined {
  return (db.prepare('SELECT role FROM org_members WHERE org_id = ? AND user_id = ?').get(orgId, userId) as { role: string } | undefined)?.role
}

// Always pass the org that OWNS the resource (event.org_id, venue.org_id), never one taken from the URL alone.
export async function requireOrgRole(orgId: number, roles: string[]) {
  const u = await requireSelf() // organizer mutations are refused while impersonating
  const role = memberRole(u.id, orgId)
  if (!role || !roles.includes(role)) redirect('/')
  return { user: u, role }
}

// Fresh token on login (no session fixation); the old guest session is discarded.
export async function login(userId: number) {
  const old = (await cookies()).get(COOKIE)?.value
  await logout()
  const token = createSession(userId)
  // carry the guest session's in-progress rows over, or logging in mid-checkout loses the hold
  if (old) tx(() => {
    db.prepare("UPDATE holds SET session_token = ?, user_id = ? WHERE session_token = ? AND status = 'active'").run(token, userId, old)
    db.prepare("UPDATE payments SET session_token = ? WHERE session_token = ? AND status IN ('requires_3ds','pending') AND order_id IS NULL").run(token, old)
    db.prepare('UPDATE orders SET session_token = ? WHERE session_token = ? AND user_id IS NULL').run(token, old)
    // waiting-room place and unlocked presales follow the shopper through login
    db.prepare('UPDATE queue_entries SET session_token = ?, user_id = ? WHERE session_token = ?').run(token, userId, old)
    db.prepare('UPDATE window_unlocks SET session_token = ? WHERE session_token = ?').run(token, old)
  })
  await setCookie(token)
}

// All-in pricing toggle (cookie): fans see face + fees + tax per ticket instead of face value.
export async function allInOn(): Promise<boolean> {
  return (await cookies()).get('allin')?.value === '1'
}

export async function startImpersonation(adminId: number, targetId: number) {
  const token = startSession(adminId, targetId)
  await logout(false)
  await setCookie(token)
}

// Stop: audit, drop the impersonation session, sign the admin back in.
export async function stopImpersonation() {
  const token = (await cookies()).get(COOKIE)?.value
  const admin = token ? endSession(token) : undefined
  ;(await cookies()).delete(COOKIE)
  if (admin) await setCookie(createSession(admin))
}

export async function logout(auditStop = true) {
  const token = (await cookies()).get(COOKIE)?.value
  if (token && auditStop) endSession(token) // audits when it was an impersonation session
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
  ;(await cookies()).delete(COOKIE)
}

// Display currency chosen in the header (cookie); 'USD' unless a supported code is set. Display only.
export async function currencyPref(): Promise<string> {
  const c = (await cookies()).get('currency')?.value
  return c && /^[A-Z]{3}$/.test(c) ? c : 'USD'
}
