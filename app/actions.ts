'use server'

import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { db } from '../lib/db.ts'
import { allowed, clientIp, isBlocked } from '../lib/defense.ts'
import { checkPending, pendingToken, sendOtp, verifyOtp } from '../lib/twofa.ts'
import { checkState, PROVIDERS, socialEnabled, socialState, socialUser } from '../lib/social.ts'
import { UserError } from '../lib/platform.ts'
import { hashPassword, randomToken, verifyPassword } from '../lib/auth.ts'
import { sendEmail, APP_URL } from '../lib/notify.ts'
import { nearestCity } from '../lib/geo.ts'
import { ensureSession, login } from '../lib/session.ts'
import { validCurrency } from '../lib/currency.ts'
import { validLang } from '../lib/i18n.ts'

const field = (f: FormData, k: string) => String(f.get(k) ?? '').trim()
const fail = (path: string, msg: string): never => redirect(`${path}${path.includes('?') ? '&' : '?'}error=${encodeURIComponent(msg)}`)
// Where to go after login/signup: a same-site path only (no open redirect).
const nextOf = (f: FormData) => {
  const n = field(f, 'next')
  return /^\/(?![/\\])/.test(n) ? n : '/'
}
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
  const retry = `/signup?next=${encodeURIComponent(nextOf(f))}`
  if (!/^\S+@\S+\.\S+$/.test(email)) fail(retry, 'Enter a valid email')
  if (password.length < 8) fail(retry, 'Password must be at least 8 characters')
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) fail(retry, 'Email already registered')
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (email, name, password_hash) VALUES (?,?,?)')
    .run(email, name, hashPassword(password))
  const id = Number(lastInsertRowid)
  const code = newCode(id, 'verify', 72)
  sendEmail(email, 'Verify your TicketStorm email', `Welcome to TicketStorm! Verify your email: ${APP_URL}/verify?code=${code}`)
  await login(id)
  redirect(nextOf(f))
}

// Password (or social) step passed for a 2FA account: nobody is logged in yet. Text a code and continue on the OTP page, bound to this browser session.
async function otpStep(userId: number, f: FormData, ip: string): Promise<never> {
  if (!allowed('otp-send', ip, userId, 5)) fail('/login', 'Too many codes requested, wait a minute')
  const session = await ensureSession()
  try {
    sendOtp(userId)
  } catch (e) {
    if (e instanceof UserError) fail('/login', e.message)
    throw e
  }
  redirect(`/login/otp?p=${encodeURIComponent(pendingToken(session, userId))}&next=${encodeURIComponent(nextOf(f))}`)
}

export async function loginAction(f: FormData) {
  const email = field(f, 'email').toLowerCase()
  const u = db.prepare('SELECT id, password_hash, status, twofa_enabled FROM users WHERE email = ?').get(email) as
    | { id: number; password_hash: string | null; status: string; twofa_enabled: number }
    | undefined
  const ip = clientIp(await headers())
  // same message for unknown email / wrong password / blocked
  if (isBlocked(ip, email) || !allowed('login', ip, null, 10) || !u?.password_hash || u.status !== 'active' || !verifyPassword(String(f.get('password') ?? ''), u.password_hash)) {
    fail(`/login?next=${encodeURIComponent(nextOf(f))}`, 'Invalid email or password')
  }
  if (u!.twofa_enabled) return otpStep(u!.id, f, ip)
  await login(u!.id)
  redirect(nextOf(f))
}

export async function verifyOtpAction(f: FormData) {
  const session = await ensureSession()
  const p = field(f, 'p')
  const uid = checkPending(p, session)
  if (!uid) fail('/login', 'Your login expired. Start again.')
  const back = `/login/otp?p=${encodeURIComponent(p)}&next=${encodeURIComponent(nextOf(f))}`
  // 10 tries a minute per IP/account on top of the 5 wrong guesses a single code allows
  if (!allowed('otp', clientIp(await headers()), uid!, 10)) fail(back, 'Too many attempts, wait a minute')
  const u = db.prepare('SELECT status FROM users WHERE id = ?').get(uid!) as { status: string }
  if (u.status !== 'active' || !verifyOtp(uid!, field(f, 'code'))) fail(back, 'Invalid or expired code')
  await login(uid!)
  redirect(nextOf(f))
}

export async function resendOtpAction(f: FormData) {
  const session = await ensureSession()
  const p = field(f, 'p')
  const uid = checkPending(p, session)
  if (!uid) fail('/login', 'Your login expired. Start again.')
  const back = `/login/otp?p=${encodeURIComponent(p)}&next=${encodeURIComponent(nextOf(f))}`
  if (!allowed('otp-send', clientIp(await headers()), uid!, 5)) fail(back, 'Too many codes requested, wait a minute')
  sendOtp(uid!)
  redirect(`${back}&notice=${encodeURIComponent('New code sent')}`)
}

// Mock social login, step 1: the state is bound to this browser session, then the (fake) provider's consent page.
export async function startSocial(f: FormData) {
  const provider = field(f, 'provider')
  if (!socialEnabled() || !PROVIDERS.includes(provider)) fail('/login', 'Social login is not available')
  const session = await ensureSession()
  redirect(`/auth/mock/${provider}?state=${encodeURIComponent(socialState(session, provider))}&next=${encodeURIComponent(nextOf(f))}`)
}

// Step 2: the consent form. Allow -> link by verified email or create the account, then log in (guest holds and queue place follow, see login()).
export async function completeSocial(f: FormData) {
  const provider = field(f, 'provider')
  if (!socialEnabled() || !PROVIDERS.includes(provider)) fail('/login', 'Social login is not available')
  const session = await ensureSession()
  if (field(f, 'decision') !== 'allow') fail('/login', 'Sign-in cancelled')
  if (!checkState(field(f, 'state'), session, provider, true)) fail('/login', 'That sign-in request is invalid or expired. Start again.')
  const email = field(f, 'email').toLowerCase()
  if (isBlocked(clientIp(await headers()), email)) fail('/login', 'Invalid email or password')
  let uid = 0
  try {
    uid = socialUser(provider, email, field(f, 'name'), f.get('verified') === 'on')
  } catch (e) {
    if (e instanceof UserError) fail('/login', e.message)
    throw e
  }
  if ((db.prepare('SELECT twofa_enabled t FROM users WHERE id = ?').get(uid) as { t: number }).t) return otpStep(uid, f, clientIp(await headers()))
  await login(uid)
  redirect(nextOf(f))
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
  db.prepare('DELETE FROM oauth_links WHERE user_id = ?').run(row!.user_id) // linked social logins must be re-linked after a reset
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

export async function toggleAllIn() {
  const on = (await cookies()).get('allin')?.value === '1'
  ;(await cookies()).set('allin', on ? '0' : '1', { path: '/', maxAge: 365 * 86_400 })
  // return to the referring page, same host only (no open redirect)
  const h = await headers()
  let back = '/'
  try {
    const u = new URL(h.get('referer') ?? '')
    if (u.host === h.get('host')) back = u.pathname + u.search
  } catch {}
  redirect(back)
}

export async function setCityByCoords(lat: number, lng: number) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return
  const c = nearestCity(lat, lng)
  if (c) (await cookies()).set('city', String(c.id), { path: '/', maxAge: 365 * 86_400 })
}

// Display currency (cookie). Only changes how prices are shown, never what is charged.
export async function setCurrency(f: FormData) {
  ;(await cookies()).set('currency', validCurrency(field(f, 'currency')), { path: '/', sameSite: 'lax', maxAge: 365 * 86_400 })
  const ref = (await headers()).get('referer')
  const host = (await headers()).get('host')
  redirect(ref && host && new URL(ref).host === host ? new URL(ref).pathname + new URL(ref).search : '/')
}

export async function setLang(f: FormData) {
  ;(await cookies()).set('lang', validLang(field(f, 'lang')), { path: '/', sameSite: 'lax', maxAge: 365 * 86_400 })
  const ref = (await headers()).get('referer')
  const host = (await headers()).get('host')
  redirect(ref && host && new URL(ref).host === host ? new URL(ref).pathname + new URL(ref).search : '/')
}
