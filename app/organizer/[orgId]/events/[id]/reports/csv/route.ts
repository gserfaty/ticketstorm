import { reportCsv } from '../../../../../../../lib/reports.ts'
import { loadEvent } from '../../../../../guard.ts'
import { REPORT_ROLES } from '../../../../../../../lib/organizer.ts'

// CSV of the event's charged orders. loadEvent proves the viewer belongs to the event's real org with a report role.
export async function GET(_req: Request, { params }: { params: Promise<{ orgId: string; id: string }> }) {
  const { orgId, id } = await params
  const { e } = await loadEvent(orgId, id, REPORT_ROLES)
  return new Response(reportCsv(e.id), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="event-${e.id}-orders.csv"`, 'cache-control': 'no-store' } })
}
