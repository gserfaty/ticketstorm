import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { db } from './db.ts'

// x-forwarded-for is client-controlled unless a proxy we run appends to it, so it is read only when TRUST_PROXY=1, and then the LAST entry
// (the one our proxy added), never the first. Otherwise every caller shares 'local'.
export const clientIp = (h: Headers) => (process.env.TRUST_PROXY === '1' ? h.get('x-forwarded-for')?.split(',').pop()?.trim() : '') || 'local'

// Fixed-window counter in ONE upsert. True while the caller is within `limit` hits per window.
export function hit(key: string, limit: number, windowMs = 60_000, now = Date.now()): boolean {
  const r = db
    .prepare('INSERT INTO rate_limits (key, window_start, count) VALUES (?,?,1) ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1 RETURNING count')
    .get(key, now - (now % windowMs)) as { count: number }
  return r.count <= limit
}

// Both the IP and (when logged in) the account must be under the limit.
export const allowed = (action: string, ip: string, userId: number | null, limit: number) =>
  hit(`${action}:ip:${ip}`, limit) && (userId === null || hit(`${action}:user:${userId}`, limit))

export function isBlocked(ip: string, email?: string | null): boolean {
  return !!db.prepare("SELECT 1 FROM blocklist WHERE (kind = 'ip' AND value = ?) OR (kind = 'email' AND value = ?)").get(ip, (email ?? '').toLowerCase())
}

// Math captcha. The question is derived from the nonce by HMAC, so the token proves itself without storing answers;
// each nonce gets ONE attempt (burned in rate_limits), so a token can't be replayed or used to guess.
export type Captcha = { question: string; token: string }

function secret(): string {
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('captcha_secret', ?)").run(JSON.stringify(randomBytes(32).toString('hex')))
  return JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'captcha_secret'").get() as { value: string }).value)
}
export const mac = (data: string) => createHmac('sha256', secret()).update(data).digest()
const sum = (nonce: string): [number, number] => {
  const m = mac('q' + nonce)
  return [(m[0] % 9) + 2, (m[1] % 9) + 2]
}

export function newCaptcha(now = Date.now()): Captcha {
  const nonce = randomBytes(8).toString('hex')
  const exp = now + 10 * 60_000
  const [a, b] = sum(nonce)
  return { question: `${a} + ${b}`, token: `${nonce}.${exp}.${mac(`${nonce}.${exp}`).toString('hex')}` }
}

export function checkCaptcha(token: string, answer: string, now = Date.now()): boolean {
  const [nonce, exp, sig] = token.split('.')
  if (!nonce || !exp || !sig || !(Number(exp) > now)) return false
  const want = mac(`${nonce}.${exp}`)
  const got = Buffer.from(sig, 'hex')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return false
  const burn = db.prepare('INSERT INTO rate_limits (key, window_start, count) VALUES (?,?,1) ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1 RETURNING count').get(`captcha:${nonce}`, Number(exp)) as { count: number }
  const [a, b] = sum(nonce)
  return burn.count === 1 && answer.trim() === String(a + b)
}
