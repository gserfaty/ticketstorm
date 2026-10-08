import Link from 'next/link'
import { notFound } from 'next/navigation'
import ChartPreview from '../../../components/ChartPreview.tsx'
import EventCard from '../../../components/EventCard.tsx'
import Heart from '../../../components/Heart.tsx'
import MiniMap from '../../../components/MiniMap.tsx'
import { db } from '../../../lib/db.ts'
import { listEvents } from '../../../lib/events.ts'

export const dynamic = 'force-dynamic'

type Info = { parking?: string; transit?: string; bag?: string; accessibility?: string; faq?: { q: string; a: string }[] }

export default async function VenuePage({ params }: { params: Promise<{ slug: string }> }) {
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
      <h2>Upcoming events</h2>
      {events.map((e) => <EventCard key={e.id} e={e} />)}
      {events.length === 0 && <p className="muted">No upcoming events.</p>}
    </>
  )
}
