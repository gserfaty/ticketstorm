'use server'

import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { db } from '../lib/db.ts'
import { hashPassword, randomToken, verifyPassword } from '../lib/auth.ts'
import { sendEmail, APP_URL } from '../lib/notify.ts'
import { login } from '../lib/session.ts'

const field = (f: FormData, k: string) => String(f.get(k) ?? '').trim()
const fail = (path: string, msg: string): never => redirect(`${path}${path.includes('?') ? '&' : '?'}error=${encodeURIComponent(msg)}`)
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()

function newCode(userId: number, kind: 'verify' | 'reset', hours: number): string {
  const code = randomToken()
  // one live code per kind: invalidate older unused ones
  db.prepare('UPDATE codes SET used_at = ? WHERE user_id = ? AND kind = ? AND used_at IS NULL').run(new Date().toISOString(), userId, kind)
  db.prepare('INSERT INTO codes (user_id, kind, code, expires_at) VALUES (?,?,?,?)').run(userId, kind, code, inHours(hours))
  return code
}

export async function signup(f: FormData) {
  const email = field(f, 'email').toLowerCase()
  const name = field(f, 'name')
  const password = String(f.get('password') ?? '')
  if (!/^\S+@\S+\.\S+$/.test(email)) fail('/signup', 'Enter a valid email')
  if (password.length < 8) fail('/signup', 'Password must be at least 8 characters')
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) fail('/signup', 'Email already registered')
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (email, name, password_hash) VALUES (?,?,?)')
    .run(email, name, hashPassword(password))
  const id = Number(lastInsertRowid)
  const code = newCode(id, 'verify', 72)
  sendEmail(email, 'Verify your TicketStorm email', `Welcome to TicketStorm! Verify your email: ${APP_URL}/verify?code=${code}`)
  await login(id)
  redirect('/')
}

export async function loginAction(f: FormData) {
  const email = field(f, 'email').toLowerCase()
  const u = db.prepare('SELECT id, password_hash, status FROM users WHERE email = ?').get(email) as
    | { id: number; password_hash: string | null; status: string }
    | undefined
  // same message for unknown email / wrong password / blocked
  if (!u?.password_hash || u.status !== 'active' || !verifyPassword(String(f.get('password') ?? ''), u.password_hash)) {
    fail('/login', 'Invalid email or password')
  }
  await login(u!.id)
  redirect('/')
}

export async function requestReset(f: FormData) {
  const email = field(f, 'email').toLowerCase()
  const u = db.prepare("SELECT id FROM users WHERE email = ? AND status = 'active'").get(email) as { id: number } | undefined
  const recent = u && db.prepare("SELECT 1 FROM codes WHERE user_id = ? AND kind = 'reset' AND created_at > ?").get(u.id, new Date(Date.now() - 60_000).toISOString())
  if (u && !recent) {
    const code = newCode(u.id, 'reset', 1)
    sendEmail(email, 'Reset your TicketStorm password', `Reset your password: ${APP_URL}/reset?code=${code}`)
  }
  // identical response whether or not the account exists
  redirect('/reset?sent=1')
}

export async function setPassword(f: FormData) {
  const code = field(f, 'code')
  const password = String(f.get('password') ?? '')
  const back = `/reset?code=${encodeURIComponent(code)}`
  if (password.length < 8) fail(back, 'Password must be at least 8 characters')
  const now = new Date().toISOString()
  const row = db
    .prepare("UPDATE codes SET used_at = ? WHERE kind = 'reset' AND code = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id")
    .get(now, code, now) as { user_id: number } | undefined
  if (!row) fail('/reset', 'Reset link is invalid or expired')
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), row!.user_id)
  db.prepare("UPDATE codes SET used_at = ? WHERE user_id = ? AND kind = 'reset' AND used_at IS NULL").run(now, row!.user_id)
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row!.user_id) // log out everywhere
  redirect('/login?notice=' + encodeURIComponent('Password changed. Log in with your new password.'))
}

export async function setCity(f: FormData) {
  const city = field(f, 'city')
  if (city !== '' && !/^\d+$/.test(city)) redirect('/')
  ;(await cookies()).set('city', city, { path: '/', maxAge: 365 * 86_400 })
  // return to the referring page, same host only (no open redirect)
  const h = await headers()
  let back = '/'
  try {
    const u = new URL(h.get('referer') ?? '')
    if (u.host === h.get('host')) back = u.pathname + u.search
  } catch {}
  redirect(back)
}
