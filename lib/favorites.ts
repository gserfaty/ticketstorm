import { db } from './db.ts'

export type FavKind = 'artist' | 'venue' | 'event'
export const FAV_KINDS: FavKind[] = ['artist', 'venue', 'event']

export const isFavorite = (userId: number, kind: FavKind, refId: number) =>
  !!db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND kind = ? AND ref_id = ?').get(userId, kind, refId)

// Flip and return the new state. Only call for a target that exists.
export function toggleFavorite(userId: number, kind: FavKind, refId: number): boolean {
  if (db.prepare('DELETE FROM favorites WHERE user_id = ? AND kind = ? AND ref_id = ?').run(userId, kind, refId).changes) return false
  // an event favorite remembers today's cheapest price, the baseline for price-drop alerts
  const price = kind === 'event' ? (db.prepare('SELECT min(price_cents) AS p FROM price_levels WHERE event_id = ? AND event_ids IS NULL').get(refId) as { p: number | null }).p : null
  db.prepare('INSERT OR IGNORE INTO favorites (user_id, kind, ref_id, last_price) VALUES (?,?,?,?)').run(userId, kind, refId, price)
  return true
}

const TABLE = { artist: 'artists', venue: 'venues', event: 'events' }
export const targetExists = (kind: FavKind, refId: number) => !!db.prepare(`SELECT 1 FROM ${TABLE[kind]} WHERE id = ?`).get(refId)

export function favoriteIds(userId: number, kind: FavKind): number[] {
  return (db.prepare('SELECT ref_id FROM favorites WHERE user_id = ? AND kind = ? ORDER BY created_at DESC, ref_id').all(userId, kind) as { ref_id: number }[]).map((r) => r.ref_id)
}
