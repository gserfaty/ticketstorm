import { db } from './db.ts'

// Funnel counters: one row per event view / seat hold / order, with the event and the kind and NOTHING about who did it (no session, no IP, no user).
export const FUNNEL = ['view', 'hold', 'order'] as const
export type FunnelKind = (typeof FUNNEL)[number]
export function logEvent(eventId: number, kind: FunnelKind) {
  db.prepare('INSERT INTO events_log (event_id, kind) VALUES (?,?)').run(eventId, kind)
}
export function funnel(eventId: number): Record<FunnelKind, number> {
  const out = { view: 0, hold: 0, order: 0 }
  for (const r of db.prepare('SELECT kind, count(*) AS n FROM events_log WHERE event_id = ? GROUP BY kind').all(eventId) as { kind: FunnelKind; n: number }[]) out[r.kind] = r.n
  return out
}
