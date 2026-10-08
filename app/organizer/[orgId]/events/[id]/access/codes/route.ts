import { codesCsv } from '../../../../../../../lib/access.ts'
import { UserError } from '../../../../../../../lib/platform.ts'
import { loadEvent } from '../../../../../guard.ts'

// CSV of one window's codes. loadEvent proves the viewer manages the event's real org.
export async function GET(req: Request, { params }: { params: Promise<{ orgId: string; id: string }> }) {
  const { orgId, id } = await params
  const { e } = await loadEvent(orgId, id)
  try {
    const csv = codesCsv(e.id, Number(new URL(req.url).searchParams.get('windowId')))
    return new Response(csv, { headers: { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="codes-${e.id}.csv"` } })
  } catch (err) {
    if (err instanceof UserError) return new Response(err.message, { status: 404 })
    throw err
  }
}
