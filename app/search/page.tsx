import { cookies } from 'next/headers'
import EventCard from '../../components/EventCard.tsx'
import Filters from '../../components/Filters.tsx'
import { db } from '../../lib/db.ts'
import { allGenres, parseFilters, scopeCity, searchEvents, withScope } from '../../lib/events.ts'
import { listCities } from '../../lib/geo.ts'
import { allInOn } from '../../lib/session.ts'
import { PER_PAGE, pageMath } from '../../lib/discover.ts'
import Pager from '../../components/Pager.tsx'

export default async function Search({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const ref = scopeCity((await cookies()).get('city')?.value)?.id
  const f = withScope(parseFilters(sp), sp, ref)
  const allIn = await allInOn()
  const first = searchEvents(f, PER_PAGE, { allIn, ref })
  const pg = pageMath(first.total, Array.isArray(sp.page) ? sp.page[0] : sp.page)
  const { rows, total } = pg.page === 1 ? first : searchEvents(f, PER_PAGE, { allIn, ref, offset: pg.offset })
  const venues = db.prepare('SELECT slug, name FROM venues ORDER BY name').all() as { slug: string; name: string }[]
  return (
    <>
      <h1>{f.q ? `Results for “${f.q}”` : 'Search events'}</h1>
      <Filters f={f} cities={listCities()} genres={allGenres()} venues={venues} allIn={allIn} canDistance={!!(f.city ?? ref)} />
      {f.sort === 'distance' && !(f.city ?? ref) && <p className="muted">Pick a city to sort by distance; showing by date.</p>}
      <p className="muted">{total > rows.length ? `Showing ${rows.length} of ${total} events` : `${total} event${total === 1 ? '' : 's'}`}</p>
      {rows.map((e) => <EventCard key={e.id} e={e} />)}
      <Pager path="/search" params={sp} page={pg.page} pages={pg.pages} />
    </>
  )
}
