import Link from 'next/link'
import { notFound } from 'next/navigation'
import Flash from '../../../components/Flash.tsx'
import { openWindowIds } from '../../../lib/access.ts'
import { db } from '../../../lib/db.ts'
import { eventState, getEvent, orderLimit } from '../../../lib/events.ts'
import { isSoldOut } from '../../../lib/inventory.ts'
import { displayLevels } from '../../../lib/pricing.ts'
import { allInOn, getSession, getUser } from '../../../lib/session.ts'
import { registerVerifiedFan, unlockPresale } from '../../access/actions.ts'
import Heart from '../../../components/Heart.tsx'
import { fmtDateTime, fmtDateTimeTz, money } from '../../../lib/format.ts'

type Win = { id: number; name: string; kind: string; starts_at: string; ends_at: string; requires_code: number; reg_starts: string | null; reg_ends: string | null; lottery_at: string | null }

export default async function EventPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ error?: string; notice?: string; code?: string }> }) {
  const e = getEvent((await params).slug)
  if (!e) notFound()
  const sp = await searchParams
  const nowIso = new Date().toISOString()
  const user = await getUser()
  const unlocked = openWindowIds(e!.id, (await getSession())?.token)
  const wins = (db.prepare('SELECT id, name, kind, starts_at, ends_at, requires_code, reg_starts, reg_ends, lottery_at FROM onsale_windows WHERE event_id = ? AND ends_at > ? ORDER BY starts_at').all(e!.id, nowIso) as Win[])
  const vfReg = (id: number) => user && (db.prepare('SELECT status FROM vf_registrations WHERE window_id = ? AND user_id = ?').get(id, user.id) as { status: string } | undefined)?.status
  const s = eventState(e!, Date.now(), isSoldOut(e!.id))
  const allIn = await allInOn()
  const levels = displayLevels(e!.id, allIn)
  const addons = db.prepare('SELECT kind, name, price_cents, inventory - sold AS left FROM addons WHERE event_id = ? ORDER BY id').all(e!.id) as { kind: string; name: string; price_cents: number; left: number }[]
  const offers = db.prepare('SELECT name, pct_off FROM offers WHERE event_id = ? AND pct_off > 0 ORDER BY id').all(e!.id) as { name: string; pct_off: number }[]
  const max = orderLimit(e!)
  // an unlocked presale lets this session shop before the public on-sale
  const presale = !!unlocked.length && s.label === 'Upcoming'
  const notOnSale = e!.status === 'published' || e!.status === 'rescheduled' ? e!.onsale_at && Date.parse(e!.onsale_at) > Date.now() : false
  return (
    <>
      <h1>{e!.title} <span className={`badge ${s.label.toLowerCase().replace(' ', '-')}`}>{s.label}</span> <Heart kind="event" id={e!.id} label={e!.title} /></h1>
      {e!.image && <img src={e!.image} alt="" className="hero-img" />}
      <Flash {...sp} />
      <p>{fmtDateTimeTz(e!.starts_at, e!.tz)}</p>
      {e!.doors_at && <p className="muted">Doors {fmtDateTime(e!.doors_at, e!.tz)}</p>}
      <p><Link href={`/venues/${e!.venue_slug}`}>{e!.venue}</Link> <Heart kind="venue" id={e!.venue_id} label={e!.venue} /> · {e!.address}, {e!.city}, {e!.state}</p>
      <div className="muted row">Lineup: {e!.lineup.map((a) => <span key={a.id}>{a.name} <Heart kind="artist" id={a.id} label={a.name} /></span>)}</div>
      {e!.description && <p>{e!.description}</p>}
      {levels.length > 0 && (
        <>
          <h2>Tickets {levels.length > 1 && <span className="muted">{money(levels[0].cents)} – {money(levels[levels.length - 1].cents)}</span>}</h2>
          <p className="muted">{allIn ? 'Prices include fees and tax (plus a per-order fee at checkout).' : 'Prices before fees and tax.'} Limit {max} per order, {e!.ticket_limit} per account.</p>
          <ul>{levels.map((l) => <li key={l.id}>{l.name} ({l.ticket_type}) · {money(l.cents)}{l.perks && <div className="muted">Includes: {l.perks}</div>}</li>)}</ul>
        </>
      )}
      {offers.length > 0 && <p className="muted">Discounted tickets at checkout: {offers.map((o) => `${o.name} ${o.pct_off}% off`).join(', ')}.</p>}
      {addons.length > 0 && <p className="muted">Add-ons at checkout: {addons.map((a) => `${a.name} ${money(a.price_cents)}${a.left ? '' : ' (sold out)'}`).join(', ')}.</p>}
      {wins.map((w) => (
        <div className="card" key={w.id}>
          <strong>{w.name}</strong> <span className="muted">presale {fmtDateTime(w.starts_at, e!.tz)} to {fmtDateTime(w.ends_at, e!.tz)}</span>
          {unlocked.includes(w.id) && <p className="notice">Unlocked for you: presale seats are on the map.</p>}
          {w.kind === 'verified_fan' && (
            <p>
              {w.reg_starts! <= nowIso && nowIso < w.reg_ends! ? (
                vfReg(w.id) ? <>You are registered. Registration closes {fmtDateTime(w.reg_ends!, e!.tz)}.</> : user ? (
                  <form action={registerVerifiedFan}><input type="hidden" name="eventId" value={e!.id} /><input type="hidden" name="windowId" value={w.id} /><button>Register for Verified Fan</button></form>
                ) : <a href={`/login?next=${encodeURIComponent(`/events/${e!.slug}`)}`}>Log in to register for Verified Fan</a>
              ) : nowIso < w.reg_starts! ? <>Registration opens {fmtDateTime(w.reg_starts!, e!.tz)}.</> : vfReg(w.id) ? (
                <>Registration closed. Your status: <strong>{vfReg(w.id)}</strong>{vfReg(w.id) === 'selected' && ': check your email or texts for your code.'}</>
              ) : <>Registration closed.</>}
            </p>
          )}
        </div>
      ))}
      {wins.some((w) => w.requires_code && !unlocked.includes(w.id)) && (
        <form action={unlockPresale} className="buy">
          <input type="hidden" name="eventId" value={e!.id} />
          <input name="code" defaultValue={sp.code ?? ''} placeholder="Presale code" aria-label="Presale code" required autoComplete="off" />
          <button>Unlock presale</button>
        </form>
      )}
      {e!.queue_enabled === 1 && <p><a href={`/queue/${e!.id}`}>Join the waiting room</a></p>}
      {presale && <p><strong>Public on sale {fmtDateTime(e!.onsale_at!, e!.tz)}</strong>. Your presale is open now.</p>}
      {s.canBuy || presale ? (
        <form action={`/events/${e!.slug}/tickets`} className="buy">
          <label>Quantity <select name="qty" defaultValue={Math.min(2, max)} aria-label="Quantity">
            {Array.from({ length: max }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
          </select></label>
          <button>{s.canBuy ? 'Find tickets' : 'Find presale tickets'}</button>
        </form>
      ) : notOnSale ? (
        <p><strong>On sale {fmtDateTime(e!.onsale_at!, e!.tz)}</strong></p>
      ) : s.label === 'Sold out' ? (
        <p><strong>Sold out.</strong></p>
      ) : (
        <p className="muted">Tickets are not available for this event.</p>
      )}
    </>
  )
}
