import Link from 'next/link'
import { notFound } from 'next/navigation'
import EventCard from '../../../components/EventCard.tsx'
import { db } from '../../../lib/db.ts'
import { getDiscover, guideEvents } from '../../../lib/discover.ts'
import { searchEvents } from '../../../lib/events.ts'
import { pageMeta } from '../../../lib/seo.ts'

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const g = getDiscover((await params).slug)
  return g ? pageMeta(g.title, g.blurb, `/discover/${g.slug}`) : {}
}

export default async function DiscoverPage({ params }: { params: Promise<{ slug: string }> }) {
  const g = getDiscover((await params).slug)
  if (!g) notFound()
  const picks = guideEvents(g!)
  const city = g!.city_id ? (db.prepare('SELECT id, name, state FROM cities WHERE id = ?').get(g!.city_id) as { id: number; name: string; state: string } | undefined) : undefined
  const venues = city ? (db.prepare('SELECT slug, name FROM venues WHERE city_id = ? ORDER BY name').all(city.id) as { slug: string; name: string }[]) : []
  const inCity = city ? searchEvents({ city: city.id, unit: 'mi' }, 8).rows.filter((e) => !picks.some((p) => p.e.id === e.id)) : []
  return (
    <>
      <p><Link href="/discover">Discover</Link></p>
      <h1>{g!.title}</h1>
      <p>{g!.blurb}</p>
      {picks.map(({ e, note }) => <div key={e.id}><EventCard e={e} />{note && <p className="muted">{note}</p>}</div>)}
      {city && (
        <>
          <h2>Venues in {city.name}</h2>
          <p className="row">{venues.map((v) => <Link key={v.slug} href={`/venues/${v.slug}`}>{v.name}</Link>)}</p>
          <h2>Coming up in {city.name}, {city.state}</h2>
          {inCity.map((e) => <EventCard key={e.id} e={e} />)}
          {!inCity.length && !picks.length && <p className="muted">No upcoming events right now.</p>}
        </>
      )}
    </>
  )
}
