import { exportData } from '../../../../lib/account.ts'
import { getUser } from '../../../../lib/session.ts'

// Only ever the logged-in user's own data: the id comes from the session, never from the request.
export async function GET() {
  const user = await getUser()
  if (!user) return new Response('Log in first', { status: 401 })
  return new Response(JSON.stringify(exportData(user.id), null, 2), {
    headers: { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="ticketstorm-data.json"', 'cache-control': 'no-store' },
  })
}
