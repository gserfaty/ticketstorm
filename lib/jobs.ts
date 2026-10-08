import { db, tx } from './db.ts'
import { promoteWaitlist, releaseEndedWindows, runLottery } from './access.ts'
import { runAlerts } from './alerts.ts'
import { chargeDueInstallments } from './installments.ts'
import { expireListings } from './resale.ts'
import { expireTransfers } from './transfers.ts'

// Idempotent housekeeping. Expiry itself is lazy everywhere; this only tidies up.
export function runJobs() {
  tx(() => {
    const now = new Date().toISOString()
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now)
    db.prepare('DELETE FROM codes WHERE expires_at < ?').run(now)
    db.prepare("UPDATE inventory SET status = 'available', hold_id = NULL, held_until = NULL WHERE status = 'held' AND held_until < ?").run(now)
    db.prepare("UPDATE holds SET status = 'released' WHERE status = 'active' AND expires_at < ?").run(now)
    db.prepare('DELETE FROM rate_limits WHERE window_start < ?').run(Date.now() - 3_600_000)
    db.prepare("DELETE FROM queue_entries WHERE expires_at < ?").run(new Date(Date.now() - 86_400_000).toISOString())
    releaseEndedWindows()
    db.prepare(`INSERT INTO settings (key, value) VALUES ('last_jobs_run', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(now))
  })
  runLottery()
  promoteWaitlist()
  chargeDueInstallments()
  expireTransfers()
  expireListings()
  runAlerts()
}

// Called from the root layout: at most once per 30s.
export function runJobsThrottled() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'last_jobs_run'").get() as { value: string } | undefined
  if (row && Date.now() - Date.parse(JSON.parse(row.value)) < 30_000) return
  runJobs()
}
