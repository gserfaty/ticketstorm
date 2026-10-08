import EventCard from '../../components/EventCard.tsx'
import Filters from '../../components/Filters.tsx'
import { parseFilters, searchEvents } from '../../lib/events.ts'
import { listCities } from '../../lib/geo.ts'

export default async function Search({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const f = parseFilters(await searchParams)
  const rows = searchEvents(f)
  return (
    <>
      <h1>{f.q ? `Results for “${f.q}”` : 'Search events'}</h1>
      <Filters f={f} cities={listCities()} />
      <p className="muted">{rows.length} event{rows.length === 1 ? '' : 's'}</p>
      {rows.map((e) => <EventCard key={e.id} e={e} />)}
    </>
  )
}
