import { stopImpersonation } from '../../../lib/session.ts'

// A plain POST route (not a server action) so the service worker sees a request to /impersonate/... and clears offline ticket caches.
export async function POST(req: Request) {
  await stopImpersonation()
  return Response.redirect(new URL('/admin/users', req.url), 303)
}
