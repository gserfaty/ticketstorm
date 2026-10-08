import { logout } from '../../lib/session.ts'

export async function POST(req: Request) {
  await logout()
  return Response.redirect(new URL('/', req.url), 303)
}
