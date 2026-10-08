import Link from 'next/link'
import Flash from '../../../../../../components/Flash.tsx'
import { db } from '../../../../../../lib/db.ts'
import { WINDOW_KINDS } from '../../../../../../lib/access.ts'
import { fmtDateTime } from '../../../../../../lib/format.ts'
import { loadEvent } from '../../../../guard.ts'
import { addWindowAction, assignWindowAction, generateCodesAction } from '../../../../actions.ts'

export const dynamic = 'force-dynamic'

type Win = { id: number; name: string; kind: string; starts_at: string; ends_at: string; requires_code: number; reg_ends: string | null; vf_slots: number | null; lottery_at: string | null }

export default async function Access({ params, searchParams }: { params: Promise<{ orgId: string; id: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const { orgId, id } = await params
  const { e } = await loadEvent(orgId, id)
  const wins = db.prepare('SELECT id, name, kind, starts_at, ends_at, requires_code, reg_ends, vf_slots, lottery_at FROM onsale_windows WHERE event_id = ? ORDER BY starts_at').all(e.id) as Win[]
  const sections = db.prepare('SELECT id, name FROM sections WHERE venue_id = ? ORDER BY rank, id').all(e.venue_id) as { id: number; name: string }[]
  const stat = (w: number) =>
    db.prepare('SELECT count(*) AS codes, coalesce(sum(uses), 0) AS uses, (SELECT count(*) FROM inventory WHERE window_id = ?) AS seats, (SELECT count(*) FROM vf_registrations WHERE window_id = ?) AS regs FROM access_codes WHERE window_id = ?').get(w, w, w) as { codes: number; uses: number; seats: number; regs: number }
  const base = `/organizer/${orgId}/events/${e.id}`
  const hidden = (
    <>
      <input type="hidden" name="eventId" value={e.id} />
      <input type="hidden" name="page" value="access" />
    </>
  )
  return (
    <>
      <h1>Presales and access codes: {e.title}</h1>
      <p><Link href={base}>Back to event</Link></p>
      <Flash {...(await searchParams)} />
      {wins.map((w) => {
        const st = stat(w.id)
        return (
          <div className="card" key={w.id}>
            <strong>{w.name}</strong> <span className="badge">{w.kind}</span>
            <div className="muted">{fmtDateTime(w.starts_at, e.tz)} to {fmtDateTime(w.ends_at, e.tz)} · {w.requires_code ? 'code required' : 'open to everyone'} · {st.seats} seats held back · {st.codes} codes, {st.uses} uses</div>
            {w.kind === 'verified_fan' && <div className="muted">{st.regs} registered · selects {w.vf_slots} when registration closes {fmtDateTime(w.reg_ends!, e.tz)} · {w.lottery_at ? 'lottery done' : 'lottery pending'}</div>}
            <form action={generateCodesAction} className="row">{hidden}<input type="hidden" name="windowId" value={w.id} />
              <input name="n" type="number" min="1" max="1000" defaultValue="10" aria-label="How many codes" /><input name="maxUses" type="number" min="1" defaultValue="1" aria-label="Uses per code" /><button>Generate codes</button>
              {st.codes > 0 && <a href={`${base}/access/codes?windowId=${w.id}`}>Download CSV</a>}
            </form>
            <form action={assignWindowAction} className="row">{hidden}<input type="hidden" name="windowId" value={w.id} />
              <select name="sectionId" aria-label="Section">{sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
              <input name="row" placeholder="Row (blank = section)" aria-label="Row" /><button>Hold back for this window</button>
            </form>
          </div>
        )
      })}
      <form action={assignWindowAction} className="row">{hidden}<input type="hidden" name="windowId" value="0" />
        <select name="sectionId" aria-label="Section">{sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <input name="row" placeholder="Row (blank = section)" aria-label="Row" /><button>Release held-back seats to the public</button>
      </form>
      <h2>New window</h2>
      <form action={addWindowAction} className="stack">
        {hidden}
        <input name="name" placeholder="Name (e.g. Fan club presale)" required />
        <select name="kind" aria-label="Type">{WINDOW_KINDS.map((k) => <option key={k}>{k}</option>)}</select>
        <label>Sale starts ({e.tz}) <input type="datetime-local" name="startsAt" required /></label>
        <label>Sale ends <input type="datetime-local" name="endsAt" required /></label>
        <label><input type="checkbox" name="requiresCode" defaultChecked /> Requires an access code</label>
        <p className="muted">Verified Fan only:</p>
        <label>Registration opens <input type="datetime-local" name="regStarts" /></label>
        <label>Registration closes <input type="datetime-local" name="regEnds" /></label>
        <label>Fans to select <input type="number" name="slots" min="1" defaultValue="100" /></label>
        <label>Selected fans must buy by (waitlist is promoted after) <input type="datetime-local" name="buyBy" /></label>
        <button>Add window</button>
      </form>
    </>
  )
}
