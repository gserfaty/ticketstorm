import Link from 'next/link'
import { notFound } from 'next/navigation'
import EventCard from '../../../components/EventCard.tsx'
import { CATEGORIES, genresIn, searchEvents } from '../../../lib/events.ts'

export default async function Category({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ genre?: string }> }) {
  const { slug } = await params
  const cat = CATEGORIES.find((c) => c.slug === slug)
  if (!cat) notFound()
  const genres = genresIn(slug)
  const wanted = (await searchParams).genre
  const genre = genres.find((g) => g === wanted) // only known genres
  const rows = searchEvents({ category: slug, genre, unit: 'mi' })
  return (
    <>
      <h1>{cat!.name}</h1>
      <p className="genres">
        <Link href={`/category/${slug}`} className={genre ? '' : 'on'}>All</Link>
        {genres.map((g) => <Link key={g} href={`/category/${slug}?genre=${encodeURIComponent(g)}`} className={g === genre ? 'on' : ''}>{g}</Link>)}
      </p>
      {rows.map((e) => <EventCard key={e.id} e={e} />)}
      {rows.length === 0 && <p className="muted">No upcoming events.</p>}
    </>
  )
}
