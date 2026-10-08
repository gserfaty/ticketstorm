import Link from 'next/link'
import EventCard from '../../components/EventCard.tsx'
import Heart from '../../components/Heart.tsx'
import { db } from '../../lib/db.ts'
import { eventsByIds } from '../../lib/events.ts'
import { favoriteIds } from '../../lib/favorites.ts'
import { requireUser } from '../../lib/session.ts'

export const dynamic = 'force-dynamic'

const names = (table: 'artists' | 'venues', ids: number[]) =>
  ids.length ? (db.prepare(`SELECT id, name, slug FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY name`).all(...ids) as { id: number; name: string; slug: string }[]) : []

export default async function Favorites() {
  const user = await requireUser()
  const events = eventsByIds(favoriteIds(user.id, 'event'))
  const artists = names('artists', favoriteIds(user.id, 'artist'))
  const venues = names('venues', favoriteIds(user.id, 'venue'))
  return (
    <>
      <h1>Favorites</h1>
      <h2>Events</h2>
      {events.map((e) => <EventCard key={e.id} e={e} />)}
      {events.length === 0 && <p className="muted">No favorite events. Tap ♡ on an event.</p>}
      <h2>Artists</h2>
      {artists.map((a) => <div className="card row" key={a.id}><Link href={`/artists/${a.slug}`}>{a.name}</Link> <Heart kind="artist" id={a.id} label={a.name} /></div>)}
      {artists.length === 0 && <p className="muted">No favorite artists. Tap ♡ next to a lineup on an event page.</p>}
      <h2>Venues</h2>
      {venues.map((v) => <div className="card row" key={v.id}><Link href={`/venues/${v.slug}`}>{v.name}</Link> <Heart kind="venue" id={v.id} label={v.name} /></div>)}
      {venues.length === 0 && <p className="muted">No favorite venues.</p>}
      <p><Link href="/">Find events</Link></p>
    </>
  )
}
