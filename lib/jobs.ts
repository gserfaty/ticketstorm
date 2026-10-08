import { db } from './db.ts'

// Idempotent housekeeping. Expiry itself is lazy everywhere; this only tidies up.
export function runJobs() {
  const now = new Date().toISOString()
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now)
  db.prepare('DELETE FROM codes WHERE expires_at < ?').run(now)
  db.prepare(`INSERT INTO settings (key, value) VALUES ('last_jobs_run', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(now))
}

// Called from the root layout: at most once per 30s.
export function runJobsThrottled() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'last_jobs_run'").get() as { value: string } | undefined
  if (row && Date.now() - Date.parse(JSON.parse(row.value)) < 30_000) return
  runJobs()
}
