import { cookies } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { db, tx } from './db.ts'
import { randomToken } from './auth.ts'
import type { Viewer } from './orders.ts'

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
  return db.prepare('SELECT token, user_id FROM sessions WHERE token = ? AND expires_at > ?').get(token, new Date().toISOString()) as
    | { token: string; user_id: number | null }
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

export async function requireAdmin(): Promise<User> {
  const u = await requireUser()
  if (u.role !== 'admin') notFound()
  return u
}

export async function requireOrgRole(orgId: number, roles: string[]) {
  const u = await requireUser()
  const m = db.prepare('SELECT role FROM org_members WHERE org_id = ? AND user_id = ?').get(orgId, u.id) as { role: string } | undefined
  if (!m || !roles.includes(m.role)) notFound()
  return { user: u, role: m.role }
}

// Fresh token on login (no session fixation); the old guest session is discarded.
export async function login(userId: number) {
  const old = (await cookies()).get(COOKIE)?.value
  await logout()
  const token = createSession(userId)
  // carry the guest session's in-progress rows over, or logging in mid-checkout loses the hold
  if (old) tx(() => {
    db.prepare("UPDATE holds SET session_token = ?, user_id = ? WHERE session_token = ? AND status = 'active'").run(token, userId, old)
    db.prepare("UPDATE payments SET session_token = ? WHERE session_token = ? AND status = 'requires_3ds'").run(token, old)
    db.prepare('UPDATE orders SET session_token = ? WHERE session_token = ? AND user_id IS NULL').run(token, old)
  })
  await setCookie(token)
}

export async function logout() {
  const token = (await cookies()).get(COOKIE)?.value
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
  ;(await cookies()).delete(COOKIE)
}
