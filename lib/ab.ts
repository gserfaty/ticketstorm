import { createHash } from 'node:crypto'
import { db } from './db.ts'
import { UserError } from './platform.ts'

// A/B tests ride on feature_flags: enabled + variant_pct = the share of visitors who get variant B.
// Bucketing is a pure hash of (flag key, visitor id): the same visitor always lands in the same bucket (sticky, nothing stored), and flags are independent of each other.
export const bucket = (key: string, visitorId: string): number => createHash('sha256').update(`${key}:${visitorId}`).digest().readUInt32BE(0) % 100

export function variantFor(key: string, visitorId: string): 'A' | 'B' {
  const f = db.prepare('SELECT enabled, variant_pct FROM feature_flags WHERE key = ?').get(key) as { enabled: number; variant_pct: number } | undefined
  return f?.enabled && bucket(key, visitorId) < f.variant_pct ? 'B' : 'A'
}

export function setVariantPct(key: string, pct: unknown) {
  const n = Number(pct)
  if (pct === '' || !Number.isInteger(n) || n < 0 || n > 100) throw new UserError('Variant share must be a whole number from 0 to 100')
  if (db.prepare('UPDATE feature_flags SET variant_pct = ? WHERE key = ?').run(n, key).changes !== 1) throw new UserError('Unknown flag')
  return n
}
