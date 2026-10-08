import Link from 'next/link'
import { notFound } from 'next/navigation'
import ChartPreview from '../../../components/ChartPreview.tsx'
import EventCard from '../../../components/EventCard.tsx'
import Heart from '../../../components/Heart.tsx'
import MiniMap from '../../../components/MiniMap.tsx'
import Flash from '../../../components/Flash.tsx'
import Reviews from '../../../components/Reviews.tsx'
import SeatView from '../../../components/SeatView.tsx'
import { approvedReviews, attended } from '../../../lib/reviews.ts'
import { getUser } from '../../../lib/session.ts'
import { db } from '../../../lib/db.ts'
import { listEvents } from '../../../lib/events.ts'
import { pageMeta } from '../../../lib/seo.ts'

export const dynamic = 'force-dynamic'

type Info = { parking?: string; transit?: string; bag?: string; accessibility?: string; faq?: { q: string; a: string }[] }

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const v = db.prepare('SELECT v.slug, v.name, v.address, c.name AS city FROM venues v JOIN cities c ON c.id = v.city_id WHERE v.slug = ?').get((await params).slug) as { slug: string; name: string; address: string; city: string } | undefined
  return v ? pageMeta(`${v.name}, ${v.city}: events and seating chart`, `Upcoming events, seating chart, parking and accessibility at ${v.name}, ${v.address}, ${v.city}.`, `/venues/${v.slug}`) : {}
}

export default async function VenuePage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const v = db
    .prepare('SELECT v.id, v.slug, v.name, v.address, v.lat, v.lng, v.capacity, v.info, c.name AS city, c.state FROM venues v JOIN cities c ON c.id = v.city_id WHERE v.slug = ?')
    .get((await params).slug) as { id: number; slug: string; name: string; address: string; lat: number; lng: number; capacity: number; info: string | null; city: string; state: string } | undefined
  if (!v) notFound()
  let info: Info = {}
  try { info = v!.info ? JSON.parse(v!.info) : {} } catch {}
  const sections = (db.prepare('SELECT name, path, rank, kind FROM sections WHERE venue_id = ? ORDER BY rank, id').all(v!.id) as { name: string; path: string; rank: number; kind: string }[]).map((s) => ({ ...s }))
  const adaSeats = (db.prepare('SELECT count(*) AS n FROM seats st JOIN sections s ON s.id = st.section_id WHERE s.venue_id = ? AND st.accessible = 1').get(v!.id) as { n: number }).n
  const others = (db.prepare('SELECT name, lat, lng FROM venues WHERE id != ?').all(v!.id) as { name: string; lat: number; lng: number }[]).map((o) => ({ ...o }))
  const events = listEvents('e.venue_id = ?', [v!.id])
  const user = await getUser()
  const sp = await searchParams
  // one middle seat per reserved section, drawn with the same generated view-from-seat as the seat map (an illustration, not a photo)
  const views = (db.prepare("SELECT id, name FROM sections WHERE venue_id = ? AND kind = 'reserved' ORDER BY rank, id LIMIT 6").all(v!.id) as { id: number; name: string }[]).flatMap((sec) => {
    const n = (db.prepare('SELECT count(*) AS n FROM seats WHERE section_id = ?').get(sec.id) as { n: number }).n
    const st = db.prepare('SELECT x, y, row, number, obstructed FROM seats WHERE section_id = ? ORDER BY row, number LIMIT 1 OFFSET ?').get(sec.id, n >> 1) as { x: number; y: number; row: string; number: number; obstructed: number } | undefined
    return st ? [{ name: sec.name, ...st }] : []
  })
  const tabs: [string, string | undefined][] = [['Parking', info.parking], ['Public transit', info.transit], ['Bag policy', info.bag]]
  return (
    <>
      <h1>{v!.name} <Heart kind="venue" id={v!.id} label={v!.name} /></h1>
      <p>{v!.address}, {v!.city}, {v!.state} · capacity {v!.capacity.toLocaleString('en-US')}</p>
      <div className="row">
        <MiniMap lat={v!.lat} lng={v!.lng} name={v!.name} others={others} />
        <ChartPreview sections={sections} />
      </div>
      <h2>Venue information</h2>
      {tabs.filter(([, text]) => text).map(([title, text]) => <details className="info" key={title}><summary>{title}</summary><p>{text}</p></details>)}
      <details className="info" id="accessibility" open>
        <summary>Accessibility</summary>
        <p>{info.accessibility ?? 'Contact the venue for accessibility information.'}</p>
        <p className="muted">{adaSeats} wheelchair-accessible seats on the seating chart; each has a companion seat beside it.</p>
        <p><Link href={`/support/ada?venue=${v!.slug}`}>Request an accessibility accommodation</Link></p>
      </details>
      {!!info.faq?.length && <details className="info"><summary>FAQ</summary>{info.faq.map((f) => <p key={f.q}><strong>{f.q}</strong><br />{f.a}</p>)}</details>}
      {views.length > 0 && (
        <>
          <h2>Views from the seats</h2>
          <div className="row">{views.map((w) => <div key={w.name}><SeatView x={w.x} y={w.y} obstructed={!!w.obstructed} label={`Section ${w.name} Row ${w.row} Seat ${w.number}`} /><p className="muted">Section {w.name}, Row {w.row}, Seat {w.number}</p></div>)}</div>
        </>
      )}
      <h2>Upcoming events</h2>
      {events.map((e) => <EventCard key={e.id} e={e} />)}
      {events.length === 0 && <p className="muted">No upcoming events.</p>}
      <Flash {...sp} />
      <Reviews kind="venue" refId={v!.id} back={`/venues/${v!.slug}`} {...approvedReviews('venue', v!.id)} loggedIn={!!user}
        canWrite={!!user && attended(user.id, 'venue', v!.id) && !db.prepare('SELECT 1 FROM reviews WHERE user_id = ? AND venue_id = ?').get(user.id, v!.id)} />
    </>
  )
}
