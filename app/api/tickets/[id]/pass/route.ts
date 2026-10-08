import { NextResponse } from 'next/server'
import { mac } from '../../../../../lib/defense.ts'
import { getTicket } from '../../../../../lib/orders.ts'
import { APP_URL } from '../../../../../lib/notify.ts'
import { ticketState } from '../../../../../lib/ticketstate.ts'
import { getUser, getViewer } from '../../../../../lib/session.ts'

// Simulated wallet pass (Apple/Google). Owner only. It shows what a printed pass would show plus a serial number; it NEVER contains the ticket
// secret or a scannable token: the barcode is a link back to the ticket page, where the rotating SafeTix code is drawn.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id)
  const user = await getUser()
  if (!user) return NextResponse.json({ error: 'Log in first' }, { status: 401 })
  const t = Number.isSafeInteger(id) ? getTicket(id, await getViewer()) : undefined
  if (!t || t.owner_id !== user.id) return NextResponse.json({ error: 'Ticket not found' }, { status: 404 })
  const wallet = new URL(req.url).searchParams.get('wallet') === 'google' ? 'google' : 'apple'
  const pass = {
    simulated: true,
    wallet,
    formatVersion: 1,
    passTypeIdentifier: 'pass.test.ticketstorm',
    serialNumber: `TS-${t.id}-${mac(`pass:${t.id}`).toString('hex').slice(0, 12)}`,
    organizationName: 'TicketStorm',
    description: `Ticket for ${t.title}`,
    event: { title: t.title, venue: t.venue, startsAt: t.starts_at, timeZone: t.tz },
    seat: t.addon ? { pass: t.addon } : t.row ? { section: t.section, row: t.row, number: t.number } : { section: t.section, generalAdmission: true },
    state: ticketState(t.status, t.order_status, t.starts_at),
    barcode: { format: 'PKBarcodeFormatQR', message: `${APP_URL}/tickets/${t.id}`, messageEncoding: 'iso-8859-1' },
    note: 'Mock pass for the demo. Open the link to show the rotating entry code.',
  }
  return new NextResponse(JSON.stringify(pass, null, 2), {
    headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="ticket-${t.id}.${wallet}-pass.json"`, 'cache-control': 'no-store' },
  })
}
