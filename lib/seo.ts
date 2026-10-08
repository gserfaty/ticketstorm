import { db } from './db.ts'
import { CATEGORIES } from './events.ts'
import { APP_URL } from './notify.ts'

export type Entry = { url: string; lastModified?: Date }

// Only what a stranger may see: events that are not drafts or cancelled, are approved and still ahead; venues and artists; category and discover pages.
export function sitemapEntries(): Entry[] {
  const rows = (sql: string, ...a: string[]) => db.prepare(sql).all(...a) as { slug: string }[]
  const u = (path: string) => ({ url: `${APP_URL}${path}` })
  return [
    u('/'), u('/search'), u('/map'), u('/discover'),
    ...CATEGORIES.map((c) => u(`/category/${c.slug}`)),
    ...rows('SELECT slug FROM discover ORDER BY slug').map((r) => u(`/discover/${r.slug}`)),
    ...rows("SELECT slug FROM events WHERE status NOT IN ('draft','cancelled') AND approved = 1 AND starts_at > ? ORDER BY starts_at", new Date().toISOString()).map((r) => u(`/events/${r.slug}`)),
    ...rows('SELECT slug FROM venues ORDER BY slug').map((r) => u(`/venues/${r.slug}`)),
    ...rows('SELECT slug FROM artists ORDER BY slug').map((r) => u(`/artists/${r.slug}`)),
  ]
}

// generateMetadata payload shared by the event, venue, artist, category and discover pages. Canonical URL = the slug URL, without query parameters.
export function pageMeta(title: string, description: string, path: string) {
  const url = `${APP_URL}${path}`
  return { title, description: description.slice(0, 200), alternates: { canonical: url }, openGraph: { title, description: description.slice(0, 200), url, type: 'website' as const, siteName: 'TicketStorm' } }
}
