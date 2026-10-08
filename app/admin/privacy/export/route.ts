import { exportData } from '../../../../lib/account.ts'
import { db } from '../../../../lib/db.ts'
import { audit } from '../../../../lib/platform.ts'
import { requireAdmin } from '../../../../lib/session.ts'

// Admin-only GDPR export of any user, with the same function as the self-service export. Audited; admins cannot be exported this way (they use their own page).
export async function GET(req: Request) {
  const admin = await requireAdmin()
  const id = Number(new URL(req.url).searchParams.get('id'))
  const u = Number.isInteger(id) ? (db.prepare('SELECT role FROM users WHERE id = ?').get(id) as { role: string } | undefined) : undefined
  if (!u) return new Response('User not found', { status: 404 })
  if (u.role === 'admin' && id !== admin.id) return new Response('Admin accounts cannot be exported here', { status: 403 })
  audit(admin.id, 'gdpr.export', `user:${id}`)
  return new Response(JSON.stringify(exportData(id), null, 2), { headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="user-${id}-data.json"`, 'cache-control': 'no-store' } })
}
