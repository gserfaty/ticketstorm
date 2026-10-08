import Link from 'next/link'
import Flash from '../../../../../../components/Flash.tsx'
import { fanList, MAX_PER_DAY, MAX_RECIPIENTS } from '../../../../../../lib/campaign.ts'
import { money } from '../../../../../../lib/format.ts'
import { eventReport } from '../../../../../../lib/reports.ts'
import { loadEvent } from '../../../../guard.ts'
import { sendCampaignAction } from '../../../../actions.ts'

export const dynamic = 'force-dynamic'

export default async function Marketing({ params, searchParams }: { params: Promise<{ orgId: string; id: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const { orgId, id } = await params
  const { e } = await loadEvent(orgId, id)
  const r = eventReport(e.id, e.tz)
  const fans = fanList(e.id)
  const base = `/organizer/${orgId}/events/${e.id}`
  return (
    <>
      <h1>Marketing: {e.title}</h1>
      <p><Link href={base}>Back to event</Link> · <Link href={`${base}/reports`}>Reports</Link></p>
      <Flash {...(await searchParams)} />
      <h2>Tracked links</h2>
      <p className="muted">Add <code>?src=name</code> (letters, digits, - or _, up to 32) to any link to this event, e.g. <code>/events/{e.slug}?src=newsletter</code>. Orders placed after a visit through the link are credited to that source for 30 days.</p>
      <table>
        <thead><tr><td>Source</td><td>Orders</td><td>Tickets</td><td>Charged</td></tr></thead>
        <tbody>{r.bySrc.map((s) => <tr key={s.src}><td>{s.src}</td><td>{s.orders}</td><td>{s.tickets}</td><td>{money(s.revenue)}</td></tr>)}</tbody>
      </table>
      {!r.bySrc.length && <p>No orders yet.</p>}
      <h2>Email campaign</h2>
      <p className="muted">Goes to followers of this event, its artists or venue, and buyers, who turned on &quot;News and offers&quot; email: {fans.filter((f) => f.optedIn).length} of {fans.length} fans. Every email carries an unsubscribe link. Limits: {MAX_PER_DAY} campaigns per event per day, {MAX_RECIPIENTS} recipients.</p>
      <form action={sendCampaignAction} className="stack">
        <input type="hidden" name="eventId" value={e.id} />
        <input type="hidden" name="page" value="marketing" />
        <input name="subject" placeholder="Subject" maxLength={120} required />
        <textarea name="body" rows={6} maxLength={2000} placeholder="Message" required />
        <button>Send campaign</button>
      </form>
    </>
  )
}
