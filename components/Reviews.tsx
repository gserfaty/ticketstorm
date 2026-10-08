import { reviewAction } from '../app/reviews/actions.ts'
import type { PublicReview, Target } from '../lib/reviews.ts'

// Approved reviews (plain text, escaped by React) and, for a verified attendee who has not reviewed yet, the form.
export default function Reviews({ kind, refId, back, list, avg, canWrite, loggedIn }: { kind: Target; refId: number; back: string; list: PublicReview[]; avg: number | null; canWrite: boolean; loggedIn: boolean }) {
  return (
    <section aria-label="Reviews">
      <h2>Reviews {avg !== null && <span className="muted">{avg.toFixed(1)} / 5 from {list.length}{list.length === 20 ? '+' : ''} verified attendee{list.length === 1 ? '' : 's'}</span>}</h2>
      {list.map((r, i) => <div className="card" key={i}><span aria-label={`${r.rating} out of 5 stars`}>{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}</span> <span className="muted">Verified attendee · {r.created_at.slice(0, 10)}</span><p>{r.body}</p></div>)}
      {!list.length && <p className="muted">No reviews yet. Only people who attended (a ticket scanned at the door) can write one.</p>}
      {canWrite ? (
        <form action={reviewAction} className="stack">
          <input type="hidden" name="kind" value={kind} /><input type="hidden" name="refId" value={refId} /><input type="hidden" name="back" value={back} />
          <label>Rating <select name="rating" defaultValue="5">{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} star{n === 1 ? '' : 's'}</option>)}</select></label>
          <label>Your review <textarea name="body" rows={3} maxLength={1000} required /></label>
          <button>Submit review</button>
        </form>
      ) : <p className="muted">{loggedIn ? 'You can review this after you attend (or you already have).' : 'Log in to review a show you attended.'}</p>}
    </section>
  )
}
