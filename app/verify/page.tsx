import { db } from '../../lib/db.ts'

export default async function Verify({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code = '' } = await searchParams
  const now = new Date().toISOString()
  const row = db
    .prepare("SELECT id, user_id FROM codes WHERE kind = 'verify' AND code = ? AND used_at IS NULL AND expires_at > ?")
    .get(code, now) as { id: number; user_id: number } | undefined
  if (row) {
    db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(now, row.user_id)
    db.prepare('UPDATE codes SET used_at = ? WHERE id = ?').run(now, row.id)
  }
  return row ? (
    <>
      <h1>Email verified</h1>
      <p className="notice">Thanks, your email is confirmed.</p>
    </>
  ) : (
    <>
      <h1>Verification failed</h1>
      <p className="error">This link is invalid, expired, or already used.</p>
    </>
  )
}
