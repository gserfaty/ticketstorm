import { cookies } from 'next/headers'
import EventCard from '../../components/EventCard.tsx'
import Filters from '../../components/Filters.tsx'
import { db } from '../../lib/db.ts'
import { allGenres, parseFilters, searchEvents } from '../../lib/events.ts'
import { listCities } from '../../lib/geo.ts'
import { allInOn } from '../../lib/session.ts'

export default async function Search({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const f = parseFilters(await searchParams)
  const allIn = await allInOn()
  const cityCookie = (await cookies()).get('city')?.value ?? ''
  const ref = /^\d+$/.test(cityCookie) ? Number(cityCookie) : undefined
  const { rows, total } = searchEvents(f, 60, { allIn, ref })
  const venues = db.prepare('SELECT slug, name FROM venues ORDER BY name').all() as { slug: string; name: string }[]
  return (
    <>
      <h1>{f.q ? `Results for “${f.q}”` : 'Search events'}</h1>
      <Filters f={f} cities={listCities()} genres={allGenres()} venues={venues} allIn={allIn} canDistance={!!(f.city ?? ref)} />
      {f.sort === 'distance' && !(f.city ?? ref) && <p className="muted">Pick a city to sort by distance; showing by date.</p>}
      <p className="muted">{total > rows.length ? `Showing ${rows.length} of ${total} events` : `${total} event${total === 1 ? '' : 's'}`}</p>
      {rows.map((e) => <EventCard key={e.id} e={e} />)}
    </>
  )
}
