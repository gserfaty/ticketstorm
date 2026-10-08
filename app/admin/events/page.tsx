import Flash from '../../../components/Flash.tsx'
import { db } from '../../../lib/db.ts'
import { likeEscape } from '../../../lib/format.ts'
import { requireAdmin } from '../../../lib/session.ts'
import { editEventText, setEventApproval } from '../actions.ts'

export const dynamic = 'force-dynamic'

export default async function AdminEvents({ searchParams }: { searchParams: Promise<{ q?: string; error?: string; notice?: string }> }) {
  await requireAdmin()
  const sp = await searchParams
  const events = db
    .prepare("SELECT e.id, e.title, e.description, e.status, e.approved, o.name AS org FROM events e JOIN orgs o ON o.id = e.org_id WHERE e.title LIKE ? ESCAPE '\\' AND e.status != 'draft' ORDER BY e.approved, e.starts_at LIMIT 100")
    .all(`%${likeEscape(sp.q ?? '')}%`) as { id: number; title: string; description: string | null; status: string; approved: number; org: string }[]
  return (
    <>
      <h1>Events</h1>
      <Flash {...sp} />
      <form className="filters"><input name="q" defaultValue={sp.q ?? ''} placeholder="Search title" aria-label="Search" /><button>Search</button></form>
      {events.map((e) => (
        <div className="card" key={e.id}>
          {e.title} <span className="badge">{e.status}</span> <span className="badge">{e.approved ? 'visible' : 'awaiting approval / hidden'}</span> <span className="muted">{e.org}</span>
          <form action={setEventApproval} className="buy"><input type="hidden" name="eventId" value={e.id} /><input type="hidden" name="approved" value={e.approved ? '0' : '1'} /><button>{e.approved ? 'Unpublish' : 'Approve'}</button></form>
          <details>
            <summary>Edit text</summary>
            <form action={editEventText} className="stack"><input type="hidden" name="eventId" value={e.id} /><input name="title" defaultValue={e.title} required /><textarea name="description" defaultValue={e.description ?? ''} rows={3} /><button>Save</button></form>
          </details>
        </div>
      ))}
    </>
  )
}
