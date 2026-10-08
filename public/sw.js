/* TicketStorm offline tickets.
   What it does: when the network fails, serve a ticket page (/tickets, /tickets/<id>) that the signed-in owner saved earlier, so the QR (computed in the
   browser from the ticket secret with crypto.subtle) still rotates. Pages are saved by components/OfflineTickets.tsx into one cache per user.
   What it never does: cache anything but those two page kinds and /_next/static assets; touch POSTs; answer for an online request (network first).
   Cleared on logout and on any login/signup POST, so the next person on the device never sees the previous person's tickets. */
const STATIC = 'ts-static'
const isTicketPage = (u) => /^\/tickets(\/\d+)?$/.test(u.pathname)
const isAuthPost = (u) => /^\/(logout|login|signup|auth)(\/|$)/.test(u.pathname)

async function clearAll() {
  for (const k of await caches.keys()) if (k.startsWith('ts-')) await caches.delete(k)
}
async function savedTicketPage(url) {
  for (const k of await caches.keys()) {
    if (!k.startsWith('ts-tickets-')) continue
    const hit = await (await caches.open(k)).match(url)
    if (hit) return hit
  }
}

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('message', (e) => { if (e.data === 'clear') e.waitUntil(clearAll()) })

self.addEventListener('fetch', (e) => {
  const req = e.request
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (req.method !== 'GET') {
    if (isAuthPost(url)) e.waitUntil(clearAll()) // the request itself goes on to the network untouched
    return
  }
  if (req.mode === 'navigate' && isTicketPage(url)) {
    e.respondWith(fetch(req).catch(async () => (await savedTicketPage(req.url)) || new Response('You are offline and this ticket page was not saved on this device. Open it once while online.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } })))
  } else if (url.pathname.startsWith('/_next/static/')) {
    e.respondWith(fetch(req).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(STATIC).then((c) => c.put(req, copy)) } return r }).catch(() => caches.match(req)))
  }
})
