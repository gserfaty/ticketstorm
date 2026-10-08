import { randomBytes, timingSafeEqual } from 'node:crypto'
import { db, tx } from './db.ts'
import { mac } from './defense.ts'
import { UserError } from './platform.ts'

// Mock "Sign in with Google / Apple / Facebook". There is no real identity provider: the consent page lets the visitor type the identity,
// so this exists for dev and demos only and is switched off in production.
export const PROVIDERS = ['google', 'apple', 'facebook']
export const socialEnabled = () => process.env.NODE_ENV !== 'production'

// CSRF state: HMAC over (session, provider, nonce, expiry), so it only works in the browser session that started the flow, for that provider.
// Single use: the nonce is burned when the consent form is accepted.
export function socialState(sessionToken: string, provider: string, now = Date.now()): string {
  const nonce = randomBytes(8).toString('hex')
  const exp = now + 10 * 60_000
  return `${nonce}.${exp}.${mac(`social:${sessionToken}:${provider}:${nonce}:${exp}`).toString('hex')}`
}

export function checkState(state: string, sessionToken: string, provider: string, burn: boolean, now = Date.now()): boolean {
  const [nonce, exp, sig] = state.split('.')
  if (!nonce || !exp || !sig || !(Number(exp) > now)) return false
  const want = mac(`social:${sessionToken}:${provider}:${nonce}:${exp}`)
  const got = Buffer.from(sig, 'hex')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return false
  if (!burn) return true
  const r = db.prepare('INSERT INTO rate_limits (key, window_start, count) VALUES (?,?,1) ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1 RETURNING count').get(`social:${nonce}`, Number(exp)) as { count: number }
  return r.count === 1
}

// Sign in a provider identity. Known (provider, subject) -> that user. Otherwise an existing account with the same email is linked ONLY if the
// provider says the email is verified (an unverified claim would let anyone take over an account); no account -> a new one is created.
export function socialUser(provider: string, email: string, name: string, verified: boolean): number {
  email = email.trim().toLowerCase()
  if (!PROVIDERS.includes(provider) || !/^\S+@\S+\.\S+$/.test(email)) throw new UserError('Enter a valid email')
  return tx(() => {
    const link = db.prepare('SELECT user_id FROM oauth_links WHERE provider = ? AND subject = ?').get(provider, email) as { user_id: number } | undefined
    let uid = link?.user_id
    if (!uid) {
      const u = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number } | undefined
      if (!verified) throw new UserError(`${provider} has not verified this email, so it cannot be used to sign in`)
      uid = u?.id ?? Number(db.prepare('INSERT INTO users (email, name, email_verified_at) VALUES (?,?,?)').run(email, name.trim().slice(0, 80), verified ? new Date().toISOString() : null).lastInsertRowid) // verified is always true here
      db.prepare('INSERT INTO oauth_links (user_id, provider, subject) VALUES (?,?,?)').run(uid, provider, email)
      if (u && verified) db.prepare('UPDATE users SET email_verified_at = coalesce(email_verified_at, ?) WHERE id = ?').run(new Date().toISOString(), uid)
    }
    if ((db.prepare('SELECT status FROM users WHERE id = ?').get(uid) as { status: string }).status !== 'active') throw new UserError('This account is unavailable')
    return uid
  })
}
