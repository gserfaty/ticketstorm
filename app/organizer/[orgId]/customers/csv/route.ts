import { notFound } from 'next/navigation'
import { audit } from '../../../../../lib/platform.ts'
import { customersCsv } from '../../../../../lib/reports.ts'
import { REPORT_ROLES } from '../../../../../lib/organizer.ts'
import { requireOrgRole } from '../../../../../lib/session.ts'

// Buyers of THIS organization's events only (the org comes from the URL but the role is checked against that same org). Every download is audited.
export async function GET(_req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const orgId = Number((await params).orgId)
  if (!Number.isInteger(orgId)) notFound()
  const { user } = await requireOrgRole(orgId, REPORT_ROLES)
  const { csv, rows } = customersCsv(orgId)
  audit(user.id, 'customers.export', `org:${orgId}`, { rows })
  return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="org-${orgId}-customers.csv"`, 'cache-control': 'no-store' } })
}
