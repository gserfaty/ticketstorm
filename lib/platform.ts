import { db } from './db.ts'

// An error whose message is safe to show the user (validation, permission-ish business rules).
export class UserError extends Error {}

export const flagOn = (key: string) => !!(db.prepare('SELECT enabled FROM feature_flags WHERE key = ?').get(key) as { enabled: number } | undefined)?.enabled

export function setFlag(key: string, on: boolean) {
  db.prepare('INSERT INTO feature_flags (key, enabled) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled').run(key, on ? 1 : 0)
}

export function audit(actorId: number, action: string, target: string, data: unknown = {}) {
  db.prepare('INSERT INTO audit_log (actor_id, action, target, data) VALUES (?,?,?,?)').run(actorId, action, target, JSON.stringify(data))
}
