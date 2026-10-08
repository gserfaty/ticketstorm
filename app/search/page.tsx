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
  const { rows, total } = searchEvents(f, 60, { allIn, ref: /^\d+$/.test(cityCookie) ? Number(cityCookie) : undefined })
  const venues = db.prepare('SELECT slug, name FROM venues ORDER BY name').all() as { slug: string; name: string }[]
  return (
    <>
      <h1>{f.q ? `Results for “${f.q}”` : 'Search events'}</h1>
      <Filters f={f} cities={listCities()} genres={allGenres()} venues={venues} allIn={allIn} />
      <p className="muted">{total > rows.length ? `Showing ${rows.length} of ${total} events` : `${total} event${total === 1 ? '' : 's'}`}</p>
      {rows.map((e) => <EventCard key={e.id} e={e} />)}
    </>
  )
}
