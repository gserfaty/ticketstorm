import Link from 'next/link'
import Flash from '../../../../components/Flash.tsx'
import { db } from '../../../../lib/db.ts'
import { exchangeable, otherDates, previewExchange } from '../../../../lib/exchange.ts'
import { fmtDateTimeTz, money } from '../../../../lib/format.ts'
import { displayLevels } from '../../../../lib/pricing.ts'
import { getSession, requireUser } from '../../../../lib/session.ts'
import { UserError } from '../../../../lib/platform.ts'
import { HoldError } from '../../../../lib/inventory.ts'
import { confirmExchange, holdForExchange } from '../../exchange-actions.ts'

export const dynamic = 'force-dynamic'

export default async function Exchange({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ hold?: string; error?: string; notice?: string }> }) {
  const user = await requireUser()
  const id = Number((await params).id)
  const sp = await searchParams
  const session = await getSession()
  let old
  try {
    old = exchangeable(id, user.id)
  } catch (e) {
    if (e instanceof UserError || e instanceof HoldError) return <><h1>Exchange</h1><p className="error">{e.message}</p></>
    throw e
  }
  const holdId = Number(sp.hold)
  let preview
  if (Number.isInteger(holdId) && holdId > 0 && session) {
    try {
      preview = previewExchange(id, holdId, user.id, session.token)
    } catch (e) {
      if (!(e instanceof UserError || e instanceof HoldError)) throw e
    }
  }
  const dest = preview && (db.prepare('SELECT e.title, e.starts_at, v.tz, v.name AS venue FROM events e JOIN venues v ON v.id = e.venue_id WHERE e.id = ?').get(preview.eventId) as { title: string; starts_at: string; tz: string; venue: string })
  return (
    <>
      <h1>Exchange ticket</h1>
      <Flash error={sp.error} notice={sp.notice} />
      <p><Link href={`/tickets/${id}`}>Back to the ticket</Link> · this ticket cost {money(old.value)} with fees and tax.</p>
      {preview && dest ? (
        <div className="card">
          <p>New seat held for you: <strong>{preview.line.label}</strong> at {dest.title}, {dest.venue}, {fmtDateTimeTz(dest.starts_at, dest.tz)} · {money(preview.value)}.</p>
          <p>{preview.diff > 0 ? `You pay ${money(preview.diff)} more` : preview.diff < 0 ? `You get ${money(-preview.diff)} back` : 'No price difference'} (on the card you paid with).</p>
          <form action={confirmExchange} className="buy">
            <input type="hidden" name="ticketId" value={id} />
            <input type="hidden" name="holdId" value={holdId} />
            <button>Confirm exchange</button>
          </form>
        </div>
      ) : (
        otherDates(old).map((e) => (
          <form key={e.id} action={holdForExchange} className="card buy">
            <input type="hidden" name="ticketId" value={id} />
            <input type="hidden" name="eventId" value={e.id} />
            <span>{e.title} · {e.venue} · {fmtDateTimeTz(e.starts_at, e.tz)}</span>
            <select name="levelId" aria-label="Ticket type">
              {displayLevels(e.id, false).filter((l) => !l.bundle).map((l) => <option key={l.id} value={l.id}>{l.name} {money(l.cents)}</option>)}
            </select>
            <button>Find a seat</button>
          </form>
        ))
      )}
      {!preview && otherDates(old).length === 0 && <p>No other dates of this tour are on sale right now.</p>}
    </>
  )
}
