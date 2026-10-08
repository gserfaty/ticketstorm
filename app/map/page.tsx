import Link from 'next/link'
import EventCard from '../../components/EventCard.tsx'
import { CATEGORIES, parseFilters, searchEvents } from '../../lib/events.ts'
import { allInOn } from '../../lib/session.ts'
import { pageMeta } from '../../lib/seo.ts'

export const metadata = pageMeta('Events near you on a map', 'Every venue with upcoming events, on a map.', '/map')
export const dynamic = 'force-dynamic'

// Equirectangular projection of the lower 48 (+ Toronto): no tiles, no scripts, links only. x = longitude scaled by cos(37 deg), y = latitude.
const W = 900
const LNG = [-125, -66]
const LAT = [24, 50]
const K = Math.cos((37 * Math.PI) / 180)
const H = Math.round(((LAT[1] - LAT[0]) / ((LNG[1] - LNG[0]) * K)) * W)
const pos = (lat: number, lng: number): [number, number] => [((lng - LNG[0]) / (LNG[1] - LNG[0])) * W, ((LAT[1] - lat) / (LAT[1] - LAT[0])) * H]

export default async function EventMap({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const f = parseFilters(sp)
  const { rows } = searchEvents(f, 1000, { allIn: await allInOn() })
  const byVenue = new Map<string, { slug: string; name: string; city: string; lat: number; lng: number; n: number }>()
  for (const r of rows) {
    const v = byVenue.get(r.venue_slug) ?? { slug: r.venue_slug, name: r.venue, city: r.city, lat: r.vlat, lng: r.vlng, n: 0 }
    v.n++
    byVenue.set(r.venue_slug, v)
  }
  const sel = typeof sp.venue === 'string' ? byVenue.get(sp.venue) : undefined
  const q = (extra: Record<string, string>) => `/map?${new URLSearchParams({ ...(f.category ? { category: f.category } : {}), ...extra })}`
  return (
    <>
      <h1>Map of events</h1>
      <p className="genres">
        <Link href="/map" className={f.category ? '' : 'on'}>All</Link>
        {CATEGORIES.map((c) => <Link key={c.slug} href={q({ category: c.slug })} className={f.category === c.slug ? 'on' : ''}>{c.name}</Link>)}
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="minimap" style={{ maxWidth: '100%' }} role="group" aria-label="Map of venues with upcoming events">
        <rect width={W} height={H} fill="#0b0c1a" />
        {[30, 35, 40, 45].map((lat) => <line key={lat} x1={0} x2={W} y1={pos(lat, 0)[1]} y2={pos(lat, 0)[1]} stroke="#223" />)}
        {[-120, -110, -100, -90, -80, -70].map((lng) => <line key={lng} y1={0} y2={H} x1={pos(0, lng)[0]} x2={pos(0, lng)[0]} stroke="#223" />)}
        {[...byVenue.values()].map((v) => {
          const [x, y] = pos(v.lat, v.lng)
          return (
            <a key={v.slug} href={q({ venue: v.slug })} aria-label={`${v.name}, ${v.city}: ${v.n} events`}>
              <circle cx={x} cy={y} r={5 + Math.min(v.n, 20) / 2} fill={sel?.slug === v.slug ? '#4ade80' : '#3b82f6'} fillOpacity={0.8} stroke="#fff" />
              <text x={x + 10} y={y + 4} fontSize={11} fill="#cde">{v.city} ({v.n})</text>
            </a>
          )
        })}
      </svg>
      <p className="muted">Schematic map: dot size is the number of upcoming events at a venue. <Link href="/search">List view</Link></p>
      {sel ? (
        <>
          <h2>{sel.name}, {sel.city}</h2>
          {rows.filter((r) => r.venue_slug === sel.slug).map((e) => <EventCard key={e.id} e={e} />)}
        </>
      ) : <p className="muted">Pick a dot to see its events.</p>}
    </>
  )
}
