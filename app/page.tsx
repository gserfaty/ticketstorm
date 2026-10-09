import { cookies } from 'next/headers'
import Link from 'next/link'
import EventCard from '../components/EventCard.tsx'
import NearMe from '../components/NearMe.tsx'
import { CATEGORIES, SCOPE_MILES, eventsNear, recommendedEvents, scopeCity, trendingEvents } from '../lib/events.ts'
import { setCity } from './actions.ts'
import { fmtDateTime } from '../lib/format.ts'
import { topPicks } from '../lib/discover.ts'
import { getUser } from '../lib/session.ts'

// Shown when the chosen city has nothing for a rail: say so and offer "All locations" instead of silently showing other cities.
function Empty({ city }: { city?: { name: string } }) {
  if (!city) return null
  return (
    <form action={setCity} className="muted">
      <input type="hidden" name="city" value="" />
      No upcoming events within {SCOPE_MILES} miles of {city.name}. <button>Show all locations</button>
    </form>
  )
}

export default async function Home() {
  const city = scopeCity((await cookies()).get('city')?.value)
  const [hero, ...rest] = trendingEvents(9, city?.id)
  const near = city ? eventsNear(city.id, SCOPE_MILES, 6) : []
  const user = await getUser()
  const picks = recommendedEvents(user?.id ?? null, city?.id, 6, city?.id)
  const top = topPicks(3, city?.id)
  return (
    <>
      {!hero && <Empty city={city} />}
      {hero && (
        <div className="hero">
          <div className="muted">Featured</div>
          <h1><Link href={`/events/${hero.slug}`}>{hero.title}</Link></h1>
          <div>{hero.venue}, {hero.city} · {fmtDateTime(hero.starts_at, hero.tz)}</div>
        </div>
      )}
      <p className="genres">{CATEGORIES.map((c) => <Link key={c.slug} href={`/category/${c.slug}`}>{c.name}</Link>)}</p>
      <h2>Top picks</h2>
      {top.map((e) => <EventCard key={e.id} e={e} />)}
      {!top.length && <Empty city={city} />}
      <p className="muted"><Link href="/discover">Editors&apos; lists and city guides</Link> · <Link href="/map">Events on a map</Link></p>
      <h2>Trending</h2>
      {rest.map((e) => <EventCard key={e.id} e={e} />)}
      {!rest.length && <Empty city={city} />}
      <h2>{user ? 'Recommended for you' : 'Popular picks'}</h2>
      {picks.map((e) => <EventCard key={e.id} e={e} />)}
      {!picks.length && <Empty city={city} />}
      <h2>Near you{city ? ` · ${city.name}, ${city.state}` : ''}</h2>
      {city ? (
        near.length ? near.map((e) => <EventCard key={e.id} e={e} />) : <Empty city={city} />
      ) : (
        <p className="muted">Pick a city in the header or share your location.</p>
      )}
      <NearMe />
    </>
  )
}
