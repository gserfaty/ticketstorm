import { db } from '../../../../lib/db.ts'
import { fmtDateTimeTz, money } from '../../../../lib/format.ts'
import { APP_URL } from '../../../../lib/notify.ts'

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

// Embeddable event card. Plain HTML, no scripts, no forms, no cookies read or set: nothing in the frame acts as the logged-in user. The button is a link
// that opens the main site in a new tab, where the visitor logs in and buys. This is the only route that may be framed (see next.config.ts).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id)
  const e = Number.isInteger(id)
    ? (db
        .prepare(
          `SELECT e.slug, e.title, e.starts_at, e.status, v.name AS venue, v.tz, c.name AS city, (SELECT min(price_cents) FROM price_levels WHERE event_id = e.id AND event_ids IS NULL) AS from_cents
           FROM events e JOIN venues v ON v.id = e.venue_id JOIN cities c ON c.id = v.city_id WHERE e.id = ? AND e.status != 'draft' AND e.approved = 1`,
        )
        .get(id) as { slug: string; title: string; starts_at: string; status: string; venue: string; tz: string; city: string; from_cents: number | null } | undefined)
    : undefined
  const headers = { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "frame-ancestors *; default-src 'none'; style-src 'unsafe-inline'; img-src data:", 'cache-control': 'public, max-age=60' }
  if (!e) return new Response('<!doctype html><meta charset="utf-8"><title>Not found</title><p>Event not found.</p>', { status: 404, headers })
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(e.title)} | TicketStorm</title>
<style>body{margin:0;font:15px/1.4 system-ui,sans-serif;background:#0f1020;color:#eef;padding:12px}h1{font-size:1.1rem;margin:0 0 4px}.m{color:#b6bccd;margin:2px 0}a{display:inline-block;margin-top:8px;background:#2563eb;color:#fff;padding:8px 12px;border-radius:6px;text-decoration:none}a:focus-visible{outline:3px solid #fff;outline-offset:2px}</style></head>
<body><h1>${esc(e.title)}</h1><p class="m">${esc(fmtDateTimeTz(e.starts_at, e.tz))}</p><p class="m">${esc(e.venue)}, ${esc(e.city)}</p>
${e.from_cents !== null ? `<p class="m">Tickets from ${esc(money(e.from_cents))}</p>` : ''}${e.status === 'cancelled' ? '<p class="m">This event was cancelled.</p>' : ''}
<a href="${esc(APP_URL)}/events/${esc(e.slug)}" target="_blank" rel="noopener">${e.status === 'cancelled' ? 'Details' : 'Get tickets'} on TicketStorm</a></body></html>`
  return new Response(body, { headers })
}
