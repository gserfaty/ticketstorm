import { notFound } from 'next/navigation'
import Until from '../../../components/Until.tsx'
import { fmtDateTimeTz } from '../../../lib/format.ts'
import { partyView, verifyParty } from '../../../lib/party.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Your party', robots: { index: false, follow: false } }

// Public on purpose (the signed link is the credential) and read-only: seats and event info, no ticket codes.
export default async function Party({ params }: { params: Promise<{ token: string }> }) {
  const who = verifyParty((await params).token)
  const p = who && partyView(who.userId, who.eventId)
  if (!p) notFound()
  return (
    <>
      <h1>{p!.host}&apos;s party</h1>
      <div className="card">
        <strong>{p!.title}</strong>
        <div className="muted">{p!.venue} · {fmtDateTimeTz(p!.starts_at, p!.tz)}</div>
        {Date.parse(p!.starts_at) > Date.now() && <div><Until iso={p!.starts_at} label="Show starts in" /></div>}
        <ul>{p!.seats.map((s, i) => <li key={i}>{s.label} · <span className="badge">{s.state}</span></li>)}</ul>
        {!p!.seats.length && <p className="muted">No tickets are held for this event right now.</p>}
      </div>
      <p className="muted">This page only shows where everyone sits. Each person needs their own ticket to get in; entry codes are never shown here.</p>
    </>
  )
}
