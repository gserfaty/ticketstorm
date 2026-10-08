import { randomInt, timingSafeEqual } from 'node:crypto'
import { db, tx } from './db.ts'
import { mac } from './defense.ts'
import { verifyPassword } from './auth.ts'
import { sendSms } from './notify.ts'
import { UserError } from './platform.ts'

// SMS one-time codes for 2FA login. Codes are single-use (a conditional UPDATE), expire after OTP_MINUTES and die after MAX_ATTEMPTS wrong guesses.
export const OTP_MINUTES = 10
export const MAX_ATTEMPTS = 5

// The fixed dev code 000000 exists ONLY when NODE_ENV=development AND DEV_OTP=1. In production, tests and `next start` codes are random.
export const devOtp = () => process.env.NODE_ENV === 'development' && process.env.DEV_OTP === '1'

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

// A new code replaces any older unused one. The text goes to the SMS outbox.
export function sendOtp(userId: number, now = Date.now()) {
  const u = db.prepare('SELECT phone FROM users WHERE id = ?').get(userId) as { phone: string | null } | undefined
  if (!u?.phone) throw new UserError('This account has no phone number')
  tx(() => {
    db.prepare("UPDATE codes SET used_at = ? WHERE user_id = ? AND kind = 'otp' AND used_at IS NULL").run(new Date(now).toISOString(), userId)
    const code = devOtp() ? '000000' : String(randomInt(1_000_000)).padStart(6, '0')
    db.prepare("INSERT INTO codes (user_id, kind, code, expires_at) VALUES (?, 'otp', ?, ?)").run(userId, code, new Date(now + OTP_MINUTES * 60_000).toISOString())
    sendSms(u.phone!, `Your TicketStorm code is ${code}. It expires in ${OTP_MINUTES} minutes.`)
  })
}

// True once, for the newest unused, unexpired code. A wrong guess counts against that code; the 5th kills it.
export function verifyOtp(userId: number, input: string, now = Date.now()): boolean {
  return tx(() => {
    const iso = new Date(now).toISOString()
    const c = db.prepare("SELECT id, code, attempts FROM codes WHERE user_id = ? AND kind = 'otp' AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1").get(userId, iso) as
      | { id: number; code: string; attempts: number }
      | undefined
    if (!c || c.attempts >= MAX_ATTEMPTS) return false
    if (!same(c.code, input.trim())) {
      db.prepare('UPDATE codes SET attempts = attempts + 1 WHERE id = ?').run(c.id)
      return false
    }
    return db.prepare('UPDATE codes SET used_at = ? WHERE id = ? AND used_at IS NULL').run(iso, c.id).changes === 1
  })
}

// Proof that THIS browser session passed the password step for this user, so the OTP page can't be reached by guessing a user id.
export function pendingToken(sessionToken: string, userId: number, now = Date.now()): string {
  const exp = now + OTP_MINUTES * 60_000
  return `${userId}.${exp}.${mac(`2fa:${sessionToken}:${userId}:${exp}`).toString('hex')}`
}
export function checkPending(token: string, sessionToken: string, now = Date.now()): number | undefined {
  const [uid, exp, sig] = token.split('.')
  if (!uid || !exp || !sig || !/^\d+$/.test(uid) || !(Number(exp) > now)) return undefined
  const want = mac(`2fa:${sessionToken}:${uid}:${exp}`)
  const got = Buffer.from(sig, 'hex')
  return got.length === want.length && timingSafeEqual(got, want) ? Number(uid) : undefined
}

// ponytail: the phone number is not verified when 2FA is switched on (a typo locks the user out until support turns it off).
// Turn 2FA on or off. Both re-check the password (a hijacked session can't switch it off). Needs a phone to text.
export function setTwofa(userId: number, password: string, on: boolean) {
  const u = db.prepare('SELECT password_hash, phone FROM users WHERE id = ?').get(userId) as { password_hash: string | null; phone: string | null }
  if (!u.password_hash || !verifyPassword(password, u.password_hash)) throw new UserError('Wrong password')
  if (on && !u.phone) throw new UserError('Add a phone number to your profile first')
  db.prepare('UPDATE users SET twofa_enabled = ? WHERE id = ?').run(on ? 1 : 0, userId)
}
