import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, salt, hash] = stored.split('$')
  if (alg !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'hex')
  return timingSafeEqual(scryptSync(password, Buffer.from(salt, 'hex'), 64), expected)
}

export function randomToken(): string {
  return randomBytes(24).toString('hex')
}
