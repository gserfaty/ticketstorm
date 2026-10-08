import Link from 'next/link'
import { notFound } from 'next/navigation'
import EventCard from '../../../components/EventCard.tsx'
import Pager from '../../../components/Pager.tsx'
import { PER_PAGE, pageMath } from '../../../lib/discover.ts'
import { CATEGORIES, genresIn, searchEvents } from '../../../lib/events.ts'
import { pageMeta } from '../../../lib/seo.ts'

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const slug = (await params).slug
  const cat = CATEGORIES.find((c) => c.slug === slug)
  return cat ? pageMeta(`${cat.name} tickets`, `Upcoming ${cat.name.toLowerCase()} events on TicketStorm.`, `/category/${cat.slug}`) : {}
}

export default async function Category({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ genre?: string; page?: string }> }) {
  const { slug } = await params
  const cat = CATEGORIES.find((c) => c.slug === slug)
  if (!cat) notFound()
  const genres = genresIn(slug)
  const sp = await searchParams
  const genre = genres.find((g) => g === sp.genre) // only known genres
  const total = searchEvents({ category: slug, genre, unit: 'mi' }, 1).total
  const pg = pageMath(total, sp.page)
  const { rows } = searchEvents({ category: slug, genre, unit: 'mi' }, PER_PAGE, { offset: pg.offset })
  return (
    <>
      <h1>{cat!.name}</h1>
      <p className="genres">
        <Link href={`/category/${slug}`} className={genre ? '' : 'on'}>All</Link>
        {genres.map((g) => <Link key={g} href={`/category/${slug}?genre=${encodeURIComponent(g)}`} className={g === genre ? 'on' : ''}>{g}</Link>)}
      </p>
      {total > 0 && <p className="muted">{total > rows.length ? `Showing ${rows.length} of ${total} events` : `${total} event${total === 1 ? '' : 's'}`}</p>}
      {rows.map((e) => <EventCard key={e.id} e={e} />)}
      {rows.length === 0 && <p className="muted">No upcoming events.</p>}
      <Pager path={`/category/${slug}`} params={{ genre: genre, page: sp.page }} page={pg.page} pages={pg.pages} />
    </>
  )
}
