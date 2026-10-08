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

// "Import artists" from a pasted list (instead of a Spotify connection): one name per line (a single line may use commas). A name matches an artist when
// it is equal ignoring case, accents-free punctuation, extra spaces and a leading "the". No guessing beyond that: the rest is reported as unmatched.
const norm = (s: string) => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/^the /, '')
export function importArtists(userId: number, text: string): { added: string[]; already: string[]; unmatched: string[] } {
  let names = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (names.length === 1) names = names[0].split(',').map((l) => l.trim()).filter(Boolean)
  names = [...new Set(names)].slice(0, 200)
  const byName = new Map((db.prepare('SELECT id, name FROM artists').all() as { id: number; name: string }[]).map((a) => [norm(a.name), a]))
  const out = { added: [] as string[], already: [] as string[], unmatched: [] as string[] }
  const ins = db.prepare("INSERT OR IGNORE INTO favorites (user_id, kind, ref_id) VALUES (?, 'artist', ?)")
  for (const n of names) {
    const a = byName.get(norm(n.slice(0, 100)))
    if (!a) out.unmatched.push(n.slice(0, 100))
    else (ins.run(userId, a.id).changes ? out.added : out.already).push(a.name)
  }
  return out
}
