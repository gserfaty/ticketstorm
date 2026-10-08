import { createHmac, timingSafeEqual } from 'node:crypto'

// SafeTix rotating token: `ticketId.window.HMAC(secret, "ticketId:window")`, window = floor(ms / 15s).
// The browser (components/TicketQR.tsx) computes the same thing with crypto.subtle.
export const WINDOW_MS = 15_000
export const windowOf = (ms: number) => Math.floor(ms / WINDOW_MS)
const mac = (secret: string, ticketId: number, win: number) => createHmac('sha256', secret).update(`${ticketId}:${win}`).digest('hex')

export const makeToken = (ticketId: number, secret: string, ms = Date.now()) => {
  const w = windowOf(ms)
  return `${ticketId}.${w}.${mac(secret, ticketId, w)}`
}

export const tokenTicketId = (token: string) => {
  const m = /^(\d+)\.(\d+)\.[0-9a-f]{64}$/.exec(token)
  return m ? Number(m[1]) : undefined
}

// Accepts the current window +/- 1 (clock skew).
export function verifyToken(token: string, secret: string, ms = Date.now()): boolean {
  const m = /^(\d+)\.(\d+)\.([0-9a-f]{64})$/.exec(token)
  if (!m) return false
  const win = Number(m[2])
  if (Math.abs(windowOf(ms) - win) > 1) return false
  return timingSafeEqual(Buffer.from(m[3], 'hex'), Buffer.from(mac(secret, Number(m[1]), win), 'hex'))
}
