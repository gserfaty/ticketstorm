import Flash from '../../../components/Flash.tsx'
import { ADA_KINDS } from '../../../lib/support.ts'
import { getUser } from '../../../lib/session.ts'
import { submitAda } from './actions.ts'

export const dynamic = 'force-dynamic'

export default async function Ada({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string; event?: string; venue?: string }> }) {
  const sp = await searchParams
  const user = await getUser()
  return (
    <>
      <h1>Accessibility request</h1>
      <p className="muted">Tell us what you need and our team will follow up by email. Accessible seats with a companion seat beside them can be bought directly on the seat map.</p>
      <Flash error={sp.error} notice={sp.notice} />
      <form action={submitAda} className="stack">
        <input type="hidden" name="event" value={sp.event ?? ''} />
        <input type="hidden" name="venue" value={sp.venue ?? ''} />
        <input name="website" className="hp" tabIndex={-1} autoComplete="off" aria-hidden="true" />
        {user ? <p>Replies go to {user.email}.</p> : <input name="email" type="email" placeholder="Your email" aria-label="Your email" required />}
        <input name="name" placeholder="Name (optional)" aria-label="Name" maxLength={100} />
        <select name="need" aria-label="What do you need?">{ADA_KINDS.map((k) => <option key={k}>{k}</option>)}</select>
        <textarea name="details" rows={5} maxLength={2000} placeholder="Event, number of guests, what would help" aria-label="Details" required />
        <button>Send request</button>
      </form>
    </>
  )
}
