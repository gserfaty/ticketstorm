import Link from 'next/link'
import EventCard from '../../components/EventCard.tsx'
import { listDiscover, topPicks } from '../../lib/discover.ts'
import { pageMeta } from '../../lib/seo.ts'

export const metadata = pageMeta('Discover: guides and lists', 'Editors\' lists and city guides to find your next show.', '/discover')
export const dynamic = 'force-dynamic'

export default function Discover() {
  const all = listDiscover()
  return (
    <>
      <h1>Discover</h1>
      <h2>Top picks</h2>
      <p className="muted">The most popular upcoming event in each category.</p>
      {topPicks().map((e) => <EventCard key={e.id} e={e} />)}
      <h2>Editors&apos; lists</h2>
      {all.filter((g) => g.kind === 'list').map((g) => <div className="card" key={g.slug}><Link href={`/discover/${g.slug}`}><strong>{g.title}</strong></Link><div className="muted">{g.blurb}</div></div>)}
      <h2>City guides</h2>
      {all.filter((g) => g.kind === 'guide').map((g) => <div className="card" key={g.slug}><Link href={`/discover/${g.slug}`}><strong>{g.title}</strong></Link><div className="muted">{g.blurb}</div></div>)}
      <p><Link href="/map">See events on a map</Link></p>
    </>
  )
}
