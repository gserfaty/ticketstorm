import Link from 'next/link'
import { requireUser } from '../../../lib/session.ts'
import { importArtistsAction } from '../actions.ts'

export const dynamic = 'force-dynamic'

type Res = { added?: string; already?: string; unmatched?: string }

export default async function ImportArtists({ searchParams }: { searchParams: Promise<Res> }) {
  await requireUser()
  const r = await searchParams
  const list = (s?: string) => (s ? s.split('|') : [])
  return (
    <>
      <h1>Import artists</h1>
      <p className="muted">Paste artist names, one per line (this stands in for connecting a music service). Names are matched to our artists ignoring case and punctuation; whatever we cannot find is listed below.</p>
      <form action={importArtistsAction} className="stack">
        <textarea name="names" rows={8} maxLength={8000} placeholder={'Neon Harbor\nthe kiko tanaka\nSome Band We Do Not Sell'} aria-label="Artist names" required />
        <button>Follow these artists</button>
      </form>
      {(r.added !== undefined || r.unmatched !== undefined) && (
        <div className="card" role="status">
          <p className="notice">Followed {list(r.added).length}: {list(r.added).join(', ') || 'none'}</p>
          {list(r.already).length > 0 && <p className="muted">Already followed: {list(r.already).join(', ')}</p>}
          {list(r.unmatched).length > 0 && <p className="error">Not found ({list(r.unmatched).length}): {list(r.unmatched).join(', ')}</p>}
        </div>
      )}
      <p><Link href="/favorites">Back to favorites</Link></p>
    </>
  )
}
