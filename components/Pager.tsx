import Link from 'next/link'

// Prev/next links that keep every other query parameter (filters stay in the URL, so pages are shareable; an empty `city` is kept: it means "all locations").
export default function Pager({ path, params, page, pages }: { path: string; params: Record<string, string | string[] | undefined>; page: number; pages: number }) {
  if (pages <= 1) return null
  const href = (p: number) => {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (k !== 'page' && typeof v === 'string' && (v || k === 'city')) q.set(k, v)
    if (p > 1) q.set('page', String(p))
    const s = q.toString()
    return s ? `${path}?${s}` : path
  }
  return (
    <nav className="row" aria-label="Pages">
      {page > 1 ? <Link href={href(page - 1)} rel="prev">Previous</Link> : <span className="muted">Previous</span>}
      <span>Page {page} of {pages}</span>
      {page < pages ? <Link href={href(page + 1)} rel="next">Next</Link> : <span className="muted">Next</span>}
    </nav>
  )
}
