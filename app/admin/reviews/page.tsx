import Flash from '../../../components/Flash.tsx'
import { db } from '../../../lib/db.ts'
import { requireAdmin } from '../../../lib/session.ts'
import { reviewDecision } from '../actions.ts'

export const dynamic = 'force-dynamic'

export default async function AdminReviews({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  await requireAdmin()
  const rows = db
    .prepare(
      `SELECT r.id, r.rating, r.body, r.status, r.created_at, u.email, coalesce(e.title, v.name) AS target, CASE WHEN r.event_id IS NULL THEN 'venue' ELSE 'event' END AS kind
       FROM reviews r JOIN users u ON u.id = r.user_id LEFT JOIN events e ON e.id = r.event_id LEFT JOIN venues v ON v.id = r.venue_id ORDER BY r.status != 'pending', r.id DESC LIMIT 100`,
    )
    .all() as { id: number; rating: number; body: string; status: string; email: string; target: string; kind: string }[]
  return (
    <>
      <h1>Review moderation</h1>
      <p className="muted">Only verified attendees can write reviews. Approved reviews appear on the event or venue page; text is always shown escaped.</p>
      <Flash {...(await searchParams)} />
      {rows.map((r) => (
        <div className="card" key={r.id}>
          {r.kind} <strong>{r.target}</strong> · {r.rating}/5 · {r.email} · <span className="badge">{r.status}</span>
          <p>{r.body}</p>
          {r.status === 'pending' && (
            <form action={reviewDecision} className="row"><input type="hidden" name="reviewId" value={r.id} /><button name="decision" value="approve">Approve</button><button name="decision" value="reject">Reject</button></form>
          )}
        </div>
      ))}
      {!rows.length && <p>No reviews.</p>}
    </>
  )
}
