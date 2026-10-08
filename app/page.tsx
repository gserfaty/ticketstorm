import { cookies } from 'next/headers'
import Link from 'next/link'
import EventCard from '../components/EventCard.tsx'
import NearMe from '../components/NearMe.tsx'
import { CATEGORIES, eventsNear, recommendedEvents, trendingEvents } from '../lib/events.ts'
import { db } from '../lib/db.ts'
import { fmtDateTime } from '../lib/format.ts'
import { getUser } from '../lib/session.ts'

export default async function Home() {
  const trending = trendingEvents(9)
  const [hero, ...rest] = trending
  const cityId = (await cookies()).get('city')?.value ?? ''
  const city = /^\d+$/.test(cityId) ? (db.prepare('SELECT id, name, state FROM cities WHERE id = ?').get(Number(cityId)) as { id: number; name: string; state: string } | undefined) : undefined
  const near = city ? eventsNear(city.id, 100, 6) : []
  const user = await getUser()
  const picks = recommendedEvents(user?.id ?? null, city?.id, 6)
  return (
    <>
      {hero && (
        <div className="hero">
          <div className="muted">Featured</div>
          <h1><Link href={`/events/${hero.slug}`}>{hero.title}</Link></h1>
          <div>{hero.venue}, {hero.city} · {fmtDateTime(hero.starts_at, hero.tz)}</div>
        </div>
      )}
      <p className="genres">{CATEGORIES.map((c) => <Link key={c.slug} href={`/category/${c.slug}`}>{c.name}</Link>)}</p>
      <h2>Trending</h2>
      {rest.map((e) => <EventCard key={e.id} e={e} />)}
      <h2>{user ? 'Recommended for you' : 'Popular picks'}</h2>
      {picks.map((e) => <EventCard key={e.id} e={e} />)}
      <h2>Near you{city ? ` · ${city.name}, ${city.state}` : ''}</h2>
      {city ? (
        near.length ? near.map((e) => <EventCard key={e.id} e={e} />) : <p className="muted">No upcoming events within 100 miles.</p>
      ) : (
        <p className="muted">Pick a city in the header or share your location.</p>
      )}
      <NearMe />
    </>
  )
}
