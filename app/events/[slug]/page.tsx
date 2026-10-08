import Link from 'next/link'
import { notFound } from 'next/navigation'
import Flash from '../../../components/Flash.tsx'
import { openWindowIds } from '../../../lib/access.ts'
import { db } from '../../../lib/db.ts'
import { eventInfo, eventState, getEvent, orderLimit, otherDates } from '../../../lib/events.ts'
import { isSoldOut } from '../../../lib/inventory.ts'
import { displayLevels } from '../../../lib/pricing.ts'
import { getPriceAlert } from '../../../lib/pricealerts.ts'
import { priceAlert } from '../../alerts/actions.ts'
import { approx, displayCurrency } from '../../../lib/currency.ts'
import { allInOn, currencyPref, getSession, getUser } from '../../../lib/session.ts'
import { registerVerifiedFan, unlockPresale } from '../../access/actions.ts'
import Heart from '../../../components/Heart.tsx'
import ShareButton from '../../../components/ShareButton.tsx'
import { fmtDateTime, fmtDateTimeTz, localDate, money } from '../../../lib/format.ts'
import { logEvent } from '../../../lib/analytics.ts'
import { relatedEvents, viewingNow } from '../../../lib/discover.ts'
import { pageMeta } from '../../../lib/seo.ts'
import { weather } from '../../../lib/weather.ts'
import EventCard from '../../../components/EventCard.tsx'
import MiniMap from '../../../components/MiniMap.tsx'
import Reviews from '../../../components/Reviews.tsx'
import { approvedReviews, attended } from '../../../lib/reviews.ts'
import Until from '../../../components/Until.tsx'

type Win = { id: number; name: string; kind: string; starts_at: string; ends_at: string; requires_code: number; reg_starts: string | null; reg_ends: string | null; lottery_at: string | null }

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const slug = (await params).slug
  const e = getEvent(slug)
  return e ? pageMeta(`${e.title} tickets, ${e.venue}, ${e.city}`, `${e.title} at ${e.venue}, ${e.city}, ${e.state}. ${e.description ?? ''}`.trim(), `/events/${slug}`) : {}
}

export default async function EventPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ error?: string; notice?: string; code?: string }> }) {
  const e = getEvent((await params).slug)
  if (!e) notFound()
  if (e!.status !== 'draft') logEvent(e!.id, 'view')
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
  const info = eventInfo(e!.info)
  const others = otherDates(e!)
  const cur = displayCurrency(await currencyPref(), e!.country)
  const alert = user ? getPriceAlert(user.id, e!.id) : undefined
  const related = relatedEvents(e!)
  const viewers = viewingNow(e!.id)
  const wx = weather(localDate(e!.starts_at, e!.tz), e!.city, e!.vlat)
  const hasAda = !!db.prepare('SELECT 1 FROM sections s JOIN seats st ON st.section_id = s.id WHERE s.venue_id = ? AND st.accessible = 1 LIMIT 1').get(e!.venue_id)
  // an unlocked presale lets this session shop before the public on-sale
  const presale = !!unlocked.length && s.label === 'Upcoming'
  const notOnSale = e!.status === 'published' || e!.status === 'rescheduled' ? e!.onsale_at && Date.parse(e!.onsale_at) > Date.now() : false
  return (
    <>
      <h1>{e!.title} <span className={`badge ${s.label.toLowerCase().replace(' ', '-')}`}>{s.label}</span> <Heart kind="event" id={e!.id} label={e!.title} /></h1>
      {e!.image && <img src={e!.image} alt="" className="hero-img" />}
      <Flash {...sp} />
      {info.notices && <p className="card notice-banner" role="alert"><strong>Notice:</strong> {info.notices}</p>}
      <p>{fmtDateTimeTz(e!.starts_at, e!.tz)}{viewers > 0 && <> · <span className="badge" title="Sessions holding seats plus people in the waiting room in the last 5 minutes">{viewers} {viewers === 1 ? 'person' : 'people'} viewing</span></>}</p>
      <p className="muted">Forecast (simulated, not real weather): {wx.sky}, high {wx.highC}°C / {Math.round(wx.highC * 1.8 + 32)}°F, low {wx.lowC}°C, {wx.rainPct}% chance of rain.</p>
      <p className="row"><a className="btn" href={`/api/events/${e!.id}/ics`}>Add to calendar</a> <ShareButton title={e!.title} path={`/events/${e!.slug}`} /></p>
      <ul className="plain">
        {e!.doors_at && <li>Doors: {fmtDateTime(e!.doors_at, e!.tz)}</li>}
        {info.age && <li>Age: {info.age}</li>}
        {info.bag && <li>Bag policy: {info.bag}</li>}
        {!!info.set_times?.length && <li>Set times (venue time): {info.set_times.map((t) => `${t.act} ${t.time}`).join(' · ')}</li>}
      </ul>
      <p><Link href={`/venues/${e!.venue_slug}`}>{e!.venue}</Link> <Heart kind="venue" id={e!.venue_id} label={e!.venue} /> · {e!.address}, {e!.city}, {e!.state}</p>
      <div className="muted row">Lineup: {e!.lineup.map((a) => <span key={a.id}><Link href={`/artists/${a.slug}`}>{a.name}</Link> <Heart kind="artist" id={a.id} label={a.name} /></span>)}</div>
      {e!.description && <p>{e!.description}</p>}
      {levels.length > 0 && (
        <>
          <h2>Tickets {levels.length > 1 && <span className="muted">{money(levels[0].cents)} – {money(levels[levels.length - 1].cents)} {approx(levels[0].cents, cur)}{cur !== 'USD' ? ` – ${approx(levels[levels.length - 1].cents, cur).replace('≈ ', '')}` : ''}</span>}</h2>
          <p className="muted">{allIn ? 'Prices include fees and tax (plus a per-order fee at checkout).' : 'Prices before fees and tax.'} Limit {max} per order, {e!.ticket_limit} per account.{cur !== 'USD' && <> Amounts in {cur} are approximate (fixed demo rate, display only); you are always charged in USD.</>}</p>
          {e!.country !== 'US' && <p className="notice-banner card"><strong>International event ({e!.city}, {e!.country}).</strong> Tax at checkout is the local rate for this city (VAT/GST/HST, {(db.prepare('SELECT tax_rate_bps AS b FROM cities WHERE name = ?').get(e!.city) as { b: number }).b / 100}%).</p>}
          <ul>{levels.map((l) => <li key={l.id}>{l.name} ({l.ticket_type}) · {money(l.cents)} <span className="muted">{approx(l.cents, cur)}</span>{l.perks && <div className="muted">Includes: {l.perks}</div>}</li>)}</ul>
        </>
      )}
      <p className="row">
        <span className="badge">{e!.print_ok ? 'Mobile or print-at-home tickets' : 'Mobile tickets only'}</span>
        {!!e!.willcall_ok && <span className="badge">Will-call pickup available</span>}
        {!!e!.non_transferable && <span className="badge" title="Tickets cannot be sent to someone else or resold">Non-transferable</span>}
      </p>
      {s.canBuy && levels.length > 0 && (
        user ? (
          <form action={priceAlert} className="row">
            <input type="hidden" name="eventId" value={e!.id} />
            <label>Alert me when tickets are $ <input name="target" inputMode="decimal" size={6} pattern="\d{1,5}(\.\d{1,2})?" required defaultValue={alert ? (alert.target_cents / 100).toFixed(2) : ''} aria-label="Target price in dollars" /> or less</label>
            <button>{alert ? 'Update alert' : 'Set price alert'}</button>
            {alert && <button name="clear" value="1" formNoValidate>Remove</button>}
            {alert && <span className="muted">{alert.notified ? 'We told you when this price was reached.' : `Watching for ${money(alert.target_cents)} (face price, before fees).`}</span>}
          </form>
        ) : <p className="muted"><Link href={`/login?next=${encodeURIComponent(`/events/${e!.slug}`)}`}>Log in</Link> to set a price alert.</p>
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
          {hasAda && <label><input type="checkbox" name="accessible" value="1" /> Accessible seating</label>}
          <button>{s.canBuy ? 'Find tickets' : 'Find presale tickets'}</button>
        </form>
      ) : notOnSale ? (
        <p><strong>On sale {fmtDateTime(e!.onsale_at!, e!.tz)}</strong> · <Until iso={e!.onsale_at!} label="On sale in" /></p>
      ) : s.label === 'Sold out' ? (
        <p><strong>Sold out.</strong></p>
      ) : (
        <p className="muted">Tickets are not available for this event.</p>
      )}
    {others.length > 0 && (
        <>
          <h2>Other dates</h2>
          <ul>{others.map((o) => <li key={o.id}><Link href={`/events/${o.slug}`}>{fmtDateTime(o.starts_at, o.tz)}</Link> · {o.venue}, {o.city}</li>)}</ul>
        </>
      )}
      <Reviews kind="event" refId={e!.id} back={`/events/${e!.slug}`} {...approvedReviews('event', e!.id)} loggedIn={!!user}
        canWrite={!!user && attended(user.id, 'event', e!.id) && !db.prepare('SELECT 1 FROM reviews WHERE user_id = ? AND event_id = ?').get(user.id, e!.id)} />
      <h2>Getting there</h2>
      <MiniMap lat={e!.vlat} lng={e!.vlng} name={e!.venue} />
      <p><a href={`https://www.openstreetmap.org/directions?to=${e!.vlat}%2C${e!.vlng}`} rel="noopener noreferrer" target="_blank">Get directions to {e!.venue}</a> (OpenStreetMap)</p>
      {related.length > 0 && (
        <>
          <h2>You might also like</h2>
          {related.map((r) => <EventCard key={r.id} e={r} />)}
        </>
      )}
      <p className="muted"><Link href={`/support/ada?event=${e!.slug}`}>Request an accessibility accommodation</Link> (wheelchair space, companion seat, hearing assist, ASL)</p>
    </>
  )
}
