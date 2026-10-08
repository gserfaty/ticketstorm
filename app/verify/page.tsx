import { db } from '../../lib/db.ts'

export default async function Verify({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code = '' } = await searchParams
  const now = new Date().toISOString()
  const row = db
    .prepare("UPDATE codes SET used_at = ? WHERE kind = 'verify' AND code = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id")
    .get(now, code, now) as { user_id: number } | undefined
  if (row) db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(now, row.user_id)
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
