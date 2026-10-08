import Link from 'next/link'
import { notFound } from 'next/navigation'
import EventCard from '../../../components/EventCard.tsx'
import Heart from '../../../components/Heart.tsx'
import { db } from '../../../lib/db.ts'
import { listEvents } from '../../../lib/events.ts'
import { pageMeta } from '../../../lib/seo.ts'

export const dynamic = 'force-dynamic'

const parse = <T,>(json: string | null, fallback: T): T => {
  try { return json ? JSON.parse(json) : fallback } catch { return fallback }
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const a = db.prepare('SELECT slug, name, bio FROM artists WHERE slug = ?').get((await params).slug) as { slug: string; name: string; bio: string | null } | undefined
  return a ? pageMeta(`${a.name} tickets and tour dates`, a.bio ?? `Tour dates and tickets for ${a.name}.`, `/artists/${a.slug}`) : {}
}

export default async function ArtistPage({ params }: { params: Promise<{ slug: string }> }) {
  const a = db.prepare('SELECT id, slug, name, bio, image, genres, links FROM artists WHERE slug = ?').get((await params).slug) as
    | { id: number; slug: string; name: string; bio: string | null; image: string | null; genres: string | null; links: string | null }
    | undefined
  if (!a) notFound()
  const genres = parse<string[]>(a!.genres, [])
  // only http(s) links are rendered (the JSON is organizer/seed supplied)
  const links = Object.entries(parse<Record<string, string>>(a!.links, {})).filter(([, url]) => /^https?:\/\//.test(url))
  const events = listEvents('e.id IN (SELECT event_id FROM event_artists WHERE artist_id = ?)', [a!.id])
  const related = db
    .prepare(
      `SELECT a2.name, a2.slug FROM artists a2 WHERE a2.id IN (SELECT related_id FROM artist_related WHERE artist_id = ? UNION SELECT artist_id FROM artist_related WHERE related_id = ?) ORDER BY a2.name`,
    )
    .all(a!.id, a!.id) as { name: string; slug: string }[]
  return (
    <>
      <h1>{a!.name} <Heart kind="artist" id={a!.id} label={a!.name} /></h1>
      {a!.image && /^https?:\/\//.test(a!.image) && <img src={a!.image} alt="" className="hero-img" />}
      {genres.length > 0 && <p className="muted">{genres.join(' · ')}</p>}
      {a!.bio && <p>{a!.bio}</p>}
      {links.length > 0 && <p className="row">{links.map(([name, url]) => <a key={name} href={url} rel="noopener noreferrer" target="_blank">{name}</a>)}</p>}
      <h2>Tour dates</h2>
      {events.map((e) => <EventCard key={e.id} e={e} />)}
      {events.length === 0 && <p className="muted">No upcoming dates. Follow {a!.name} to hear when new shows go on sale.</p>}
      {related.length > 0 && (
        <>
          <h2>Related artists</h2>
          <p className="row">{related.map((r) => <Link key={r.slug} href={`/artists/${r.slug}`}>{r.name}</Link>)}</p>
        </>
      )}
    </>
  )
}
